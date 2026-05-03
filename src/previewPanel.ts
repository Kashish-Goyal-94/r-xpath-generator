import * as vscode from 'vscode';
import {
    parseHTML, flattenTree, generateXPaths, pickAllTargets,
    showXPathQuickPick, ParsedElement, ElementResult, ACTIONABLE_TAGS
} from './extension';
import { ElementTreeProvider } from './treeProvider';

export class XPathPreviewPanel {
    public static currentPanel: XPathPreviewPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _context: vscode.ExtensionContext;
    private _editor: vscode.TextEditor;
    private _treeProvider: ElementTreeProvider;
    private _disposables: vscode.Disposable[] = [];

    // Element registry: maps numeric ID used in webview → ParsedElement
    private _elementMap: Map<number, ParsedElement> = new Map();

    public static createOrShow(
        context: vscode.ExtensionContext,
        editor: vscode.TextEditor,
        treeProvider: ElementTreeProvider
    ) {
        const column = vscode.ViewColumn.Beside;

        if (XPathPreviewPanel.currentPanel) {
            XPathPreviewPanel.currentPanel._panel.reveal(column);
            XPathPreviewPanel.currentPanel._update(editor);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'rXpathPreview',
            'XPath Preview',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        XPathPreviewPanel.currentPanel = new XPathPreviewPanel(panel, context, editor, treeProvider);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        editor: vscode.TextEditor,
        treeProvider: ElementTreeProvider
    ) {
        this._panel = panel;
        this._context = context;
        this._editor = editor;
        this._treeProvider = treeProvider;

        this._update(editor);

        // Handle messages from the webview (element clicks)
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                if (message.command === 'elementClicked') {
                    await this._handleElementClick(message.elementId);
                }
            },
            null,
            this._disposables
        );

        // Refresh preview when document changes
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === this._editor.document) {
                this._update(this._editor);
            }
        }, null, this._disposables);

        // Track active editor changes
        vscode.window.onDidChangeActiveTextEditor(e => {
            if (e && ['html', 'xml', 'javascriptreact', 'typescriptreact'].includes(e.document.languageId)) {
                this._editor = e;
                this._update(e);
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    private async _handleElementClick(elementId: number) {
        const el = this._elementMap.get(elementId);
        if (!el) { return; }

        // Highlight in source editor
        if (el.sourceStart !== undefined && el.sourceEnd !== undefined) {
            const startPos = this._editor.document.positionAt(el.sourceStart);
            const endPos = this._editor.document.positionAt(el.sourceEnd);
            this._editor.selection = new vscode.Selection(startPos, endPos);
            this._editor.revealRange(
                new vscode.Range(startPos, endPos),
                vscode.TextEditorRevealType.InCenter
            );
            // Bring source editor into focus briefly then return
            await vscode.window.showTextDocument(this._editor.document, this._editor.viewColumn);
        }

        // Generate XPaths and show quick pick
        const xpaths = generateXPaths(el);
        const result: ElementResult = { element: el, xpaths, selectionIndex: 0 };
        const dummySel = this._editor.selection;
        await showXPathQuickPick([result], [dummySel], this._editor, this._context);
    }

    private _update(editor: vscode.TextEditor) {
        this._editor = editor;
        this._elementMap.clear();

        const html = editor.document.getText();
        const roots = parseHTML(html, 0);
        const allElements = flattenTree(roots);

        // Assign numeric IDs to all elements
        allElements.forEach((el, i) => {
            (el as any).__previewId = i;
            this._elementMap.set(i, el);
        });

        this._panel.title = `XPath Preview — ${editor.document.fileName.split(/[\\/]/).pop()}`;
        this._panel.webview.html = this._buildWebviewHtml(html, allElements);

        // Also refresh the tree sidebar
        this._treeProvider.refresh(editor.document);
    }

    private _buildWebviewHtml(rawHtml: string, allElements: ParsedElement[]): string {
        // Build instrumented HTML: inject data-__xpid on every element
        let instrumented = rawHtml;

        // We inject attributes by rebuilding the HTML string
        // Walk elements in reverse order so string offsets stay valid
        const toInject = allElements
            .filter(el => el.sourceStart !== undefined)
            .sort((a, b) => (b.sourceStart ?? 0) - (a.sourceStart ?? 0));

        for (const el of toInject) {
            const id = (el as any).__previewId as number;
            const start = el.sourceStart!;
            // Find the first > after the tag start to inject before it
            const tagChunk = rawHtml.slice(start, start + 200);
            const closeBracket = tagChunk.search(/\s*\/?>/);
            if (closeBracket < 0) { continue; }
            const injectAt = start + closeBracket;
            instrumented =
                instrumented.slice(0, injectAt) +
                ` data-__xpid="${id}"` +
                instrumented.slice(injectAt);
        }

        const isActionable = (tag: string) => ACTIONABLE_TAGS.includes(tag);

        return /* html */`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; }

  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  /* ── Toolbar ── */
  #toolbar {
    position: sticky;
    top: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    background: var(--vscode-titleBar-activeBackground, #3c3c3c);
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    font-size: 12px;
  }
  #toolbar span { opacity: 0.7; }
  #filter-input {
    flex: 1;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-input-border, #555);
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #d4d4d4);
    font-size: 12px;
  }
  #toggle-btn {
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--vscode-button-border, #555);
    background: var(--vscode-button-secondaryBackground, #3a3a3a);
    color: var(--vscode-button-secondaryForeground, #ccc);
    cursor: pointer;
    font-size: 12px;
  }
  #toggle-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }

  /* ── Preview container ── */
  #preview-container {
    padding: 20px;
    min-height: calc(100vh - 44px);
  }

  /* ── Status bar ── */
  #status {
    position: fixed;
    bottom: 0;
    left: 0; right: 0;
    padding: 5px 14px;
    font-size: 11px;
    background: var(--vscode-statusBar-background, #007acc);
    color: var(--vscode-statusBar-foreground, #fff);
    display: flex;
    justify-content: space-between;
  }

  /* ── Element hover/click highlighting ── */
  [data-__xpid] {
    outline: 1px dashed transparent;
    transition: outline 0.1s, background 0.1s;
    cursor: pointer;
    border-radius: 2px;
  }
  [data-__xpid]:hover {
    outline: 2px solid #007acc !important;
    background: rgba(0, 122, 204, 0.08) !important;
  }
  [data-__xpid].clicked {
    outline: 2px solid #f0a500 !important;
    background: rgba(240, 165, 0, 0.12) !important;
  }

  /* Actionable elements always visible */
  input[data-__xpid],
  button[data-__xpid],
  select[data-__xpid],
  textarea[data-__xpid],
  a[data-__xpid] {
    outline: 1px dashed rgba(0,122,204,0.3);
  }

  /* ── Highlight mode: dim non-actionable ── */
  body.highlight-actionable [data-__xpid]:not(input):not(button):not(select):not(textarea):not(a) {
    opacity: 0.4;
  }
  body.highlight-actionable input[data-__xpid],
  body.highlight-actionable button[data-__xpid],
  body.highlight-actionable select[data-__xpid],
  body.highlight-actionable textarea[data-__xpid],
  body.highlight-actionable a[data-__xpid] {
    outline: 2px solid rgba(0, 200, 100, 0.6);
    opacity: 1;
  }

  /* ── Tooltip ── */
  #tooltip {
    position: fixed;
    pointer-events: none;
    background: var(--vscode-editorHoverWidget-background, #252526);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    color: var(--vscode-editorHoverWidget-foreground, #d4d4d4);
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-family: monospace;
    max-width: 320px;
    z-index: 9999;
    display: none;
    line-height: 1.6;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }
  #tooltip .tip-tag { color: #4ec9b0; font-weight: bold; }
  #tooltip .tip-attr { color: #9cdcfe; }
  #tooltip .tip-hint { color: #888; font-size: 10px; margin-top: 4px; }
</style>
</head>
<body>

<div id="toolbar">
  <span>🎯 XPath Preview</span>
  <input id="filter-input" placeholder="Filter elements (e.g. input, .form, #id)..." />
  <button id="toggle-btn" title="Toggle: show only actionable elements">Actionable only</button>
</div>

<div id="preview-container">
  ${instrumented}
</div>

<div id="status">
  <span id="status-left">Click any element to generate XPath</span>
  <span id="status-right">${allElements.length} elements • ${allElements.filter(e => isActionable(e.tag)).length} actionable</span>
</div>

<div id="tooltip"></div>

<script>
  const vscode = acquireVsCodeApi();
  const tooltip = document.getElementById('tooltip');
  const statusLeft = document.getElementById('status-left');
  const filterInput = document.getElementById('filter-input');
  const toggleBtn = document.getElementById('toggle-btn');
  let highlightMode = false;
  let lastClicked = null;

  // ── Element metadata from extension ──────────────────────────────────────
  const elementMeta = ${JSON.stringify(
      allElements.map(el => ({
          id: (el as any).__previewId,
          tag: el.tag,
          idAttr: el.id,
          name: el.name,
          type: el.type,
          placeholder: el.placeholder,
          classes: el.classes,
          text: el.textContent,
          actionable: isActionable(el.tag),
      }))
  )};

  const metaById = {};
  elementMeta.forEach(m => { metaById[m.id] = m; });

  // ── Click handler ─────────────────────────────────────────────────────────
  document.getElementById('preview-container').addEventListener('click', (e) => {
    // Walk up to find nearest element with data-__xpid
    let target = e.target;
    while (target && target !== document.body) {
      if (target.hasAttribute && target.hasAttribute('data-__xpid')) {
        e.stopPropagation();
        e.preventDefault();

        // Visual feedback
        if (lastClicked) { lastClicked.classList.remove('clicked'); }
        target.classList.add('clicked');
        lastClicked = target;

        const id = parseInt(target.getAttribute('data-__xpid'), 10);
        const meta = metaById[id];
        statusLeft.textContent = 'Generating XPath for <' + (meta?.tag ?? '?') + '>…';

        vscode.postMessage({ command: 'elementClicked', elementId: id });

        setTimeout(() => {
          statusLeft.textContent = 'Click any element to generate XPath';
        }, 3000);
        return;
      }
      target = target.parentElement;
    }
  }, true);

  // ── Tooltip on hover ──────────────────────────────────────────────────────
  document.getElementById('preview-container').addEventListener('mouseover', (e) => {
    let target = e.target;
    while (target && target !== document.body) {
      if (target.hasAttribute && target.hasAttribute('data-__xpid')) {
        const id = parseInt(target.getAttribute('data-__xpid'), 10);
        const meta = metaById[id];
        if (!meta) { break; }

        let lines = ['<span class="tip-tag">&lt;' + meta.tag + '&gt;</span>'];
        if (meta.idAttr)      { lines.push('<span class="tip-attr">id</span>="' + meta.idAttr + '"'); }
        if (meta.name)        { lines.push('<span class="tip-attr">name</span>="' + meta.name + '"'); }
        if (meta.type)        { lines.push('<span class="tip-attr">type</span>="' + meta.type + '"'); }
        if (meta.placeholder) { lines.push('<span class="tip-attr">placeholder</span>="' + meta.placeholder + '"'); }
        if (meta.classes.length) { lines.push('<span class="tip-attr">class</span>="' + meta.classes.join(' ') + '"'); }
        if (meta.text)        { lines.push('<span class="tip-attr">text</span>: "' + meta.text.slice(0, 40) + '"'); }
        lines.push('<span class="tip-hint">Click to generate XPath</span>');

        tooltip.innerHTML = lines.join('<br>');
        tooltip.style.display = 'block';
        return;
      }
      target = target.parentElement;
    }
    tooltip.style.display = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (tooltip.style.display === 'block') {
      const x = e.clientX + 14;
      const y = e.clientY + 14;
      tooltip.style.left = Math.min(x, window.innerWidth - 340) + 'px';
      tooltip.style.top = Math.min(y, window.innerHeight - 120) + 'px';
    }
  });

  document.getElementById('preview-container').addEventListener('mouseout', () => {
    tooltip.style.display = 'none';
  });

  // ── Filter input ──────────────────────────────────────────────────────────
  filterInput.addEventListener('input', () => {
    const query = filterInput.value.trim().toLowerCase();
    const all = document.querySelectorAll('[data-__xpid]');

    if (!query) {
      all.forEach(el => { el.style.outline = ''; el.style.opacity = ''; });
      return;
    }

    all.forEach(el => {
      const id = parseInt(el.getAttribute('data-__xpid'), 10);
      const meta = metaById[id];
      if (!meta) { return; }

      let match = false;
      if (query.startsWith('#')) {
        match = meta.idAttr && meta.idAttr.toLowerCase().includes(query.slice(1));
      } else if (query.startsWith('.')) {
        match = meta.classes.some(c => c.toLowerCase().includes(query.slice(1)));
      } else {
        match = meta.tag.includes(query) ||
          (meta.name && meta.name.toLowerCase().includes(query)) ||
          (meta.text && meta.text.toLowerCase().includes(query)) ||
          (meta.placeholder && meta.placeholder.toLowerCase().includes(query));
      }

      el.style.outline = match ? '2px solid #f0a500' : '1px dashed rgba(100,100,100,0.3)';
      el.style.opacity = match ? '1' : '0.25';
    });
  });

  // ── Actionable toggle ─────────────────────────────────────────────────────
  toggleBtn.addEventListener('click', () => {
    highlightMode = !highlightMode;
    document.body.classList.toggle('highlight-actionable', highlightMode);
    toggleBtn.style.background = highlightMode
      ? 'var(--vscode-button-background, #007acc)'
      : 'var(--vscode-button-secondaryBackground, #3a3a3a)';
    toggleBtn.style.color = highlightMode
      ? 'var(--vscode-button-foreground, #fff)'
      : 'var(--vscode-button-secondaryForeground, #ccc)';
  });
</script>
</body>
</html>`;
    }

    public dispose() {
        XPathPreviewPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
    }
}
