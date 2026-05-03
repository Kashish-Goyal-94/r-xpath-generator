import * as vscode from 'vscode';
import { XPathPreviewPanel } from './previewPanel';
import { ElementTreeProvider } from './treeProvider';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedElement {
    tag: string;
    id?: string;
    name?: string;
    type?: string;
    placeholder?: string;
    href?: string;
    src?: string;
    alt?: string;
    role?: string;
    textContent?: string;
    classes: string[];
    dataAttrs: Record<string, string>;
    ariaAttrs: Record<string, string>;
    rawAttrs: Record<string, string>;
    children: ParsedElement[];
    parent?: ParsedElement;
    index: number;
    // Position in source for click-to-select
    sourceStart?: number;
    sourceEnd?: number;
}

export interface RankedXPath {
    xpath: string;
    cssSelector: string;
    score: number;
    label: string;
}

export interface ElementResult {
    element: ParsedElement;
    xpaths: RankedXPath[];
    selectionIndex: number;
}

export type Framework = 'selenium-python' | 'selenium-java' | 'playwright-ts' | 'playwright-python' | 'cypress';

// ─── Utilities ────────────────────────────────────────────────────────────────

export const isDynamic = (value: string): boolean => (
    /\d{3,}/.test(value) ||
    /[_-][a-z0-9]{6,}/i.test(value) ||
    /^[a-f0-9-]{36}$/i.test(value)
);

export const isUtilityClass = (cls: string): boolean =>
    /^(mt|mb|ml|mr|mx|my|pt|pb|pl|pr|px|py|p|m|w|h|flex|grid|col|row|text|bg|border|rounded|shadow|block|inline|hidden|sm:|md:|lg:|xl:)/.test(cls);

export const isGenericTag = (tag: string): boolean =>
    ['div', 'span', 'section', 'article', 'main', 'aside', 'header', 'footer'].includes(tag);

export const VOID_TAGS = new Set([
    'input', 'br', 'hr', 'img', 'link', 'meta',
    'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr'
]);

export const ACTIONABLE_TAGS = ['input', 'button', 'a', 'select', 'textarea', 'option'];

// ─── Framework Snippet Generator ─────────────────────────────────────────────

export function getFramework(context: vscode.ExtensionContext): Framework {
    const config = vscode.workspace.getConfiguration('rXpathGenerator');
    return config.get<Framework>('framework', 'selenium-python');
}

export function generateSnippet(xpath: string, cssSelector: string, framework: Framework): string {
    switch (framework) {
        case 'selenium-python':
            return [
                `# XPath`,
                `element = driver.find_element(By.XPATH, "${xpath}")`,
                ``,
                `# CSS Selector`,
                `element = driver.find_element(By.CSS_SELECTOR, "${cssSelector}")`,
            ].join('\n');
        case 'selenium-java':
            return [
                `// XPath`,
                `WebElement element = driver.findElement(By.xpath("${xpath}"));`,
                ``,
                `// CSS Selector`,
                `WebElement element = driver.findElement(By.cssSelector("${cssSelector}"));`,
            ].join('\n');
        case 'playwright-ts':
            return [
                `// XPath`,
                `const element = page.locator('xpath=${xpath}');`,
                ``,
                `// CSS Selector`,
                `const element = page.locator('${cssSelector}');`,
            ].join('\n');
        case 'playwright-python':
            return [
                `# XPath`,
                `element = page.locator("xpath=${xpath}")`,
                ``,
                `# CSS Selector`,
                `element = page.locator("${cssSelector}")`,
            ].join('\n');
        case 'cypress':
            return [
                `// XPath (requires @cypress/xpath plugin)`,
                `cy.xpath('${xpath}')`,
                ``,
                `// CSS Selector`,
                `cy.get('${cssSelector}')`,
            ].join('\n');
        default:
            return xpath;
    }
}

// ─── HTML Tree Parser ─────────────────────────────────────────────────────────

export function parseHTML(html: string, baseOffset: number = 0): ParsedElement[] {
    const roots: ParsedElement[] = [];
    const stack: ParsedElement[] = [];
    const tokenRegex = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9-]*)>|<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)\/?>|([^<]+)/g;
    let m: RegExpExecArray | null;

    while ((m = tokenRegex.exec(html)) !== null) {
        const [full, closeTag, openTag, attrsStr, textNode] = m;
        const matchStart = baseOffset + m.index;
        const matchEnd = matchStart + full.length;

        if (closeTag) {
            const tag = closeTag.toLowerCase();
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].tag === tag) {
                    stack[i].sourceEnd = matchEnd;
                    stack.splice(i);
                    break;
                }
            }
            continue;
        }

        if (textNode) {
            const text = textNode.trim();
            if (text && stack.length > 0) {
                const parent = stack[stack.length - 1];
                if (!parent.textContent) {
                    parent.textContent = text.length < 80 ? text : undefined;
                }
            }
            continue;
        }

        if (openTag) {
            const tag = openTag.toLowerCase();
            const el = buildElement(tag, attrsStr ?? '', stack[stack.length - 1]);
            el.sourceStart = matchStart;
            el.sourceEnd = matchEnd;

            if (stack.length === 0) {
                roots.push(el);
            } else {
                const parent = stack[stack.length - 1];
                el.index = parent.children.filter(c => c.tag === tag).length + 1;
                parent.children.push(el);
            }

            const isSelfClosing = full.endsWith('/>') || VOID_TAGS.has(tag);
            if (!isSelfClosing) {
                stack.push(el);
            }
        }
    }

    return roots;
}

export function buildElement(tag: string, attrsStr: string, parent?: ParsedElement): ParsedElement {
    const attrRegex = /([\w:@-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    const rawAttrs: Record<string, string> = {};
    let m: RegExpExecArray | null;

    while ((m = attrRegex.exec(attrsStr)) !== null) {
        rawAttrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }

    const dataAttrs: Record<string, string> = {};
    const ariaAttrs: Record<string, string> = {};
    const classes = (rawAttrs['class'] ?? '').split(/\s+/).filter(Boolean);

    for (const [k, v] of Object.entries(rawAttrs)) {
        if (k.startsWith('data-')) { dataAttrs[k] = v; }
        if (k.startsWith('aria-')) { ariaAttrs[k] = v; }
    }

    return {
        tag,
        id: rawAttrs['id'],
        name: rawAttrs['name'],
        type: rawAttrs['type'],
        placeholder: rawAttrs['placeholder'],
        href: rawAttrs['href'],
        src: rawAttrs['src'],
        alt: rawAttrs['alt'],
        role: rawAttrs['role'],
        textContent: undefined,
        classes,
        dataAttrs,
        ariaAttrs,
        rawAttrs,
        children: [],
        parent,
        index: 1,
    };
}

export function flattenTree(roots: ParsedElement[]): ParsedElement[] {
    const result: ParsedElement[] = [];
    function walk(el: ParsedElement) {
        result.push(el);
        el.children.forEach(walk);
    }
    roots.forEach(walk);
    return result;
}

// ─── CSS Selector Generator ───────────────────────────────────────────────────

export function generateCSSSelector(el: ParsedElement): string {
    const { tag } = el;

    if (el.id && !isDynamic(el.id)) {
        return `#${el.id}`;
    }
    for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-test']) {
        if (el.dataAttrs[attr]) {
            return `${tag}[${attr}="${el.dataAttrs[attr]}"]`;
        }
    }
    if (el.name) { return `${tag}[name="${el.name}"]`; }
    if (el.placeholder) { return `${tag}[placeholder="${el.placeholder}"]`; }
    if (el.ariaAttrs['aria-label']) { return `${tag}[aria-label="${el.ariaAttrs['aria-label']}"]`; }
    if (el.type) {
        return el.name
            ? `${tag}[type="${el.type}"][name="${el.name}"]`
            : `${tag}[type="${el.type}"]`;
    }
    const stableClass = el.classes.find(c => !isDynamic(c) && !isUtilityClass(c));
    if (stableClass) { return `${tag}.${stableClass}`; }
    if (el.parent) {
        const p = el.parent;
        const pClass = p.classes.find(c => !isDynamic(c) && !isUtilityClass(c));
        if (p.id && !isDynamic(p.id)) { return `#${p.id} ${tag}`; }
        if (pClass) { return `.${pClass} ${tag}`; }
    }
    if (el.index > 1) { return `${tag}:nth-of-type(${el.index})`; }
    return tag;
}

// ─── XPath Validator ──────────────────────────────────────────────────────────

export function validateXPathInDocument(
    xpath: string,
    document: vscode.TextDocument
): { matchCount: number; status: 'exact' | 'broad' | 'none' | 'error' } {
    try {
        const roots = parseHTML(document.getText());
        const allElements = flattenTree(roots);
        const matchCount = countHeuristicMatches(xpath, allElements);
        if (matchCount === 0) { return { matchCount: 0, status: 'none' }; }
        if (matchCount === 1) { return { matchCount: 1, status: 'exact' }; }
        return { matchCount, status: 'broad' };
    } catch {
        return { matchCount: 0, status: 'error' };
    }
}

export function countHeuristicMatches(xpath: string, elements: ParsedElement[]): number {
    let count = 0;
    const idMatch = xpath.match(/@id='([^']+)'/);
    const nameMatch = xpath.match(/@name='([^']+)'/);
    const tagMatch = xpath.match(/\/\/([a-zA-Z*]+)(?:\[|$)/);
    const textMatch = xpath.match(/(?:normalize-space|text\(\)).*?'([^']+)'/);
    const classMatch = xpath.match(/@class.*?'([^']+)'/);
    const attrMatch = xpath.match(/@(data-[^=]+)='([^']+)'/);
    const placeholderMatch = xpath.match(/@placeholder='([^']+)'/);
    const ariaMatch = xpath.match(/@aria-label='([^']+)'/);
    const targetTag = tagMatch?.[1]?.toLowerCase();

    for (const el of elements) {
        if (targetTag && targetTag !== '*' && el.tag !== targetTag) { continue; }
        if (idMatch && el.id !== idMatch[1]) { continue; }
        if (nameMatch && el.name !== nameMatch[1]) { continue; }
        if (textMatch && el.textContent !== textMatch[1]) { continue; }
        if (placeholderMatch && el.placeholder !== placeholderMatch[1]) { continue; }
        if (ariaMatch && el.ariaAttrs['aria-label'] !== ariaMatch[1]) { continue; }
        if (classMatch && !el.classes.includes(classMatch[1])) { continue; }
        if (attrMatch && el.dataAttrs[attrMatch[1]] !== attrMatch[2]) { continue; }
        count++;
    }
    return count;
}

export function validationBadge(status: 'exact' | 'broad' | 'none' | 'error'): string {
    switch (status) {
        case 'exact':  return '✅';
        case 'broad':  return '⚠️';
        case 'none':   return '❌';
        case 'error':  return '⚙️';
    }
}

// ─── data-testid Auto-Inserter ────────────────────────────────────────────────

export async function offerTestIdInsertion(
    editor: vscode.TextEditor,
    selection: vscode.Selection,
    el: ParsedElement,
    topScore: number
) {
    if (topScore >= 7) { return; }
    const hasTestAttr = ['data-testid', 'data-cy', 'data-qa', 'data-test'].some(a => el.dataAttrs[a]);
    if (hasTestAttr) { return; }

    const choice = await vscode.window.showInformationMessage(
        `⚠️ Best XPath score is ${topScore}/10 — no stable attributes found on <${el.tag}>. Auto-insert a data-testid?`,
        'Yes, insert data-testid',
        'No thanks'
    );
    if (choice !== 'Yes, insert data-testid') { return; }

    const suggested = buildTestId(el);
    const userValue = await vscode.window.showInputBox({
        prompt: 'Enter data-testid value',
        value: suggested,
        placeHolder: 'e.g. login-submit-button',
    });
    if (!userValue) { return; }

    const selectionText = editor.document.getText(selection);
    const openTagRegex = new RegExp(`(<${el.tag})(\\s|>|/)`, 'i');
    const updated = selectionText.replace(openTagRegex, `$1 data-testid="${userValue}"$2`);

    await editor.edit(editBuilder => { editBuilder.replace(selection, updated); });
    vscode.window.showInformationMessage(`✅ Inserted data-testid="${userValue}" on <${el.tag}>`);
}

function buildTestId(el: ParsedElement): string {
    const parts: string[] = [];
    if (el.name)              { parts.push(el.name); }
    else if (el.placeholder)  { parts.push(el.placeholder.toLowerCase().replace(/\s+/g, '-')); }
    else if (el.textContent)  { parts.push(el.textContent.toLowerCase().replace(/\s+/g, '-').slice(0, 20)); }
    else if (el.type)         { parts.push(el.type); }
    parts.push(el.tag);
    return parts.join('-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-');
}

// ─── Bulk Export ──────────────────────────────────────────────────────────────

async function exportResults(results: ElementResult[], framework: Framework) {
    const exportData = results.map(r => ({
        selectionBlock: r.selectionIndex + 1,
        element: `<${r.element.tag}>`,
        topXPath: r.xpaths[0]?.xpath ?? '',
        topCSSSelector: r.xpaths[0]?.cssSelector ?? '',
        topScore: r.xpaths[0]?.score ?? 0,
        snippet: r.xpaths[0] ? generateSnippet(r.xpaths[0].xpath, r.xpaths[0].cssSelector, framework) : '',
        allXPaths: r.xpaths.map(x => ({
            label: x.label,
            xpath: x.xpath,
            cssSelector: x.cssSelector,
            score: x.score,
        })),
    }));

    const json = JSON.stringify(exportData, null, 2);
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('xpath-export.json'),
        filters: { 'JSON': ['json'] },
        saveLabel: 'Export XPaths',
    });
    if (!uri) { return; }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
    vscode.window.showInformationMessage(`✅ Exported ${results.length} element(s) to ${uri.fsPath}`);
}

// ─── Target Picker ────────────────────────────────────────────────────────────

export function pickAllTargets(allElements: ParsedElement[]): ParsedElement[] {
    const actionable = allElements.filter(e => ACTIONABLE_TAGS.includes(e.tag));
    if (actionable.length > 0) { return actionable; }
    const leaves = allElements.filter(e => e.children.length === 0);
    if (leaves.length > 0) { return leaves; }
    return allElements;
}

// ─── XPath Generator ──────────────────────────────────────────────────────────

export function generateXPaths(el: ParsedElement): RankedXPath[] {
    const { tag } = el;
    const results: Array<{ xpath: string; score: number; label: string }> = [];
    const cssSelector = generateCSSSelector(el);

    const add = (xpath: string, score: number, label: string) => results.push({ xpath, score, label });

    // 1. ID
    if (el.id) {
        if (isDynamic(el.id)) {
            const prefix = el.id.split(/[-_\d]/)[0];
            add(`//*[starts-with(@id,'${prefix}')]`, 7, 'ID (dynamic prefix)');
        } else {
            add(`//*[@id='${el.id}']`, 10, 'ID (exact)');
        }
    }

    // 2. Test automation attributes
    for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-test']) {
        if (el.dataAttrs[attr]) { add(`//${tag}[@${attr}='${el.dataAttrs[attr]}']`, 9, attr); }
    }

    // 3. Name
    if (el.name) { add(`//${tag}[@name='${el.name}']`, 8, 'name'); }

    // 4. Placeholder
    if (el.placeholder) { add(`//${tag}[@placeholder='${el.placeholder}']`, 7, 'placeholder'); }

    // 5. aria-label / aria-labelledby
    if (el.ariaAttrs['aria-label']) { add(`//${tag}[@aria-label='${el.ariaAttrs['aria-label']}']`, 7, 'aria-label'); }
    if (el.ariaAttrs['aria-labelledby']) { add(`//${tag}[@aria-labelledby='${el.ariaAttrs['aria-labelledby']}']`, 6, 'aria-labelledby'); }

    // 6. Role
    if (el.role) { add(`//*[@role='${el.role}']`, 6, 'role'); }

    // 7. Text content
    if (el.textContent) {
        const escaped = el.textContent.replace(/'/g, "\\'");
        if (el.textContent.length < 30) { add(`//${tag}[normalize-space()='${escaped}']`, 7, 'exact text'); }
        add(`//${tag}[contains(text(),'${escaped}')]`, 5, 'partial text');
    }

    // 8. type + name combo
    if (el.type) {
        const base = `//${tag}[@type='${el.type}']`;
        add(el.name ? `${base}[@name='${el.name}']` : base, el.name ? 8 : 5, el.name ? 'type+name' : 'type');
    }

    // 9. href / alt
    if (el.href && !isDynamic(el.href)) { add(`//${tag}[@href='${el.href}']`, 6, 'href'); }
    if (el.alt) { add(`//${tag}[@alt='${el.alt}']`, 6, 'alt'); }

    // 10. Other data-* attributes
    for (const [k, v] of Object.entries(el.dataAttrs)) {
        if (!['data-testid', 'data-cy', 'data-qa', 'data-test'].includes(k)) {
            add(`//${tag}[@${k}='${v}']`, 5, k);
        }
    }

    // 11. Stable class
    const stableClass = el.classes.find(c => !isDynamic(c) && !isUtilityClass(c));
    if (stableClass) { add(`//${tag}[contains(@class,'${stableClass}')]`, 4, 'class'); }

    // 12. Parent ID → child
    if (el.parent) {
        const p = el.parent;
        if (p.id && !isDynamic(p.id)) {
            add(`//*[@id='${p.id}']//${tag}`, 8, 'parent#id > child');
            if (el.index > 0) { add(`//*[@id='${p.id}']/${tag}[${el.index}]`, 7, 'parent#id > nth child'); }
        }
        const pStableClass = p.classes.find(c => !isDynamic(c) && !isUtilityClass(c));
        if (pStableClass) { add(`//${p.tag}[contains(@class,'${pStableClass}')]//${tag}`, 6, 'parent.class > child'); }
    }

    // 13. Preceding sibling text → target (label → input)
    const siblings = el.parent?.children ?? [];
    const myIdx = siblings.indexOf(el);
    if (myIdx > 0) {
        for (let i = myIdx - 1; i >= 0; i--) {
            const prev = siblings[i];
            if (prev.textContent) {
                const escaped = prev.textContent.replace(/'/g, "\\'");
                add(`//${prev.tag}[normalize-space()='${escaped}']/following-sibling::${tag}`, 9, `label→${tag} (sibling text)`);
                add(`//${prev.tag}[contains(text(),'${escaped}')]/following-sibling::${tag}[1]`, 8, `label→${tag} (1st sibling)`);
                break;
            }
        }
    }

    // 14. Following sibling
    if (myIdx >= 0 && myIdx < siblings.length - 1) {
        for (let i = myIdx + 1; i < siblings.length; i++) {
            const next = siblings[i];
            if (next.textContent) {
                const escaped = next.textContent.replace(/'/g, "\\'");
                add(`//${tag}/following-sibling::${next.tag}[normalize-space()='${escaped}']`, 6, `${tag}→sibling text`);
                break;
            }
            if (next.id && !isDynamic(next.id)) {
                add(`//${tag}/following-sibling::${next.tag}[@id='${next.id}']`, 7, `${tag}→sibling#id`);
                break;
            }
        }
    }

    // 15. Ancestor text → descendant
    let ancestor = el.parent;
    let depth = 0;
    while (ancestor && depth < 3) {
        if (ancestor.textContent && !isGenericTag(ancestor.tag)) {
            const escaped = ancestor.textContent.replace(/'/g, "\\'");
            add(`//${ancestor.tag}[contains(.,'${escaped}')]//${tag}`, 6, `ancestor text→${tag}`);
            break;
        }
        ancestor = ancestor.parent;
        depth++;
    }

    // 16. Positional fallback
    if (el.index > 1) { add(`(//${tag})[${el.index}]`, 2, `positional [${el.index}]`); }

    // 17. Tag fallback
    add(`//${tag}`, 1, 'tag only');

    const seen = new Set<string>();
    return results
        .filter(r => { if (seen.has(r.xpath)) { return false; } seen.add(r.xpath); return true; })
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map(r => ({ ...r, cssSelector }));
}

// ─── Shared XPath QuickPick ───────────────────────────────────────────────────

export async function showXPathQuickPick(
    allResults: ElementResult[],
    selections: readonly vscode.Selection[],
    editor: vscode.TextEditor,
    context: vscode.ExtensionContext
) {
    const framework = getFramework(context);

    type QItem = vscode.QuickPickItem & {
        xpath: string;
        cssSelector: string;
        result: ElementResult;
        selIdx: number;
    };

    const items: QItem[] = [];

    for (const result of allResults) {
        const { element, xpaths, selectionIndex } = result;

        items.push({
            label: `$(file-code) Selection ${selectionIndex + 1} — <${element.tag}>`,
            kind: vscode.QuickPickItemKind.Separator,
            xpath: '', cssSelector: '', result, selIdx: selectionIndex,
        });

        for (const x of xpaths) {
            const { matchCount: mc, status } = validateXPathInDocument(x.xpath, editor.document);
            const badge = validationBadge(status);
            items.push({
                label: `${badge} [${x.score}/10] ${x.label}`,
                description: x.xpath,
                detail: `CSS: ${x.cssSelector}  •  ${mc} match${mc !== 1 ? 'es' : ''} in document`,
                xpath: x.xpath,
                cssSelector: x.cssSelector,
                result,
                selIdx: selectionIndex,
            });
        }
    }

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: selections.length > 1
            ? `${allResults.length} elements found across ${selections.length} selections — pick one to copy`
            : 'Select an XPath to copy — ranked by reliability',
        title: 'R XPath Generator',
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (!picked || !picked.xpath) { return; }

    // Copy mode
    const copyMode = await vscode.window.showQuickPick(
        [
            { label: '$(clippy) Copy raw XPath', description: picked.xpath, id: 'xpath' },
            { label: '$(symbol-misc) Copy raw CSS Selector', description: picked.cssSelector, id: 'css' },
            { label: `$(code) Copy code snippet (${framework})`, description: `Both XPath + CSS in ${framework} syntax`, id: 'snippet' },
        ],
        { placeHolder: 'What do you want to copy?', title: 'Copy Format' }
    );

    if (!copyMode) { return; }

    let toCopy = '';
    if (copyMode.id === 'xpath') { toCopy = picked.xpath; }
    else if (copyMode.id === 'css') { toCopy = picked.cssSelector; }
    else { toCopy = generateSnippet(picked.xpath, picked.cssSelector, framework); }

    await vscode.env.clipboard.writeText(toCopy);
    vscode.window.showInformationMessage(
        `✅ Copied (${copyMode.id}): ${toCopy.split('\n')[0]}${toCopy.includes('\n') ? ' …' : ''}`
    );

    // data-testid offer
    const topScore = picked.result.xpaths[0]?.score ?? 0;
    const targetSelection = selections[picked.selIdx];
    if (targetSelection) {
        await offerTestIdInsertion(editor, targetSelection, picked.result.element, topScore);
    }
}

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {

    // ── Element Tree Sidebar ──────────────────────────────────────────────────
    const treeProvider = new ElementTreeProvider();
    vscode.window.registerTreeDataProvider('rXpathElementTree', treeProvider);

    // Refresh tree when active editor changes or document is saved
    vscode.window.onDidChangeActiveTextEditor(e => {
        if (e?.document) { treeProvider.refresh(e.document); }
    }, null, context.subscriptions);

    vscode.workspace.onDidSaveTextDocument(doc => {
        if (vscode.window.activeTextEditor?.document === doc) {
            treeProvider.refresh(doc);
        }
    }, null, context.subscriptions);

    // Load tree for current file on startup
    if (vscode.window.activeTextEditor?.document) {
        treeProvider.refresh(vscode.window.activeTextEditor.document);
    }

    // ── Generate XPath command (editor selection) ─────────────────────────────
    const generateCommand = vscode.commands.registerCommand(
        'r-xpath-generator.generateXPath',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showErrorMessage('No active editor found'); return; }

            const selections = editor.selections.filter(s => !s.isEmpty);
            if (selections.length === 0) {
                vscode.window.showErrorMessage('Please select one or more HTML elements first');
                return;
            }

            const allResults: ElementResult[] = [];
            for (let si = 0; si < selections.length; si++) {
                const selectionText = editor.document.getText(selections[si]);
                if (!selectionText.trim()) { continue; }

                const roots = parseHTML(selectionText);
                const allElements = flattenTree(roots);
                if (allElements.length === 0) { continue; }

                for (const target of pickAllTargets(allElements)) {
                    allResults.push({ element: target, xpaths: generateXPaths(target), selectionIndex: si });
                }
            }

            if (allResults.length === 0) {
                vscode.window.showErrorMessage('Could not parse any HTML elements from selection(s)');
                return;
            }

            await showXPathQuickPick(allResults, selections, editor, context);
        }
    );

    // ── Open HTML Preview command ──────────────────────────────────────────────
    const previewCommand = vscode.commands.registerCommand(
        'r-xpath-generator.openPreview',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showErrorMessage('No active editor found'); return; }

            const langId = editor.document.languageId;
            if (!['html', 'xml', 'javascriptreact', 'typescriptreact'].includes(langId)) {
                vscode.window.showErrorMessage('Open an HTML file first to use the preview');
                return;
            }

            XPathPreviewPanel.createOrShow(context, editor, treeProvider);
        }
    );

    // ── Generate XPath from tree click ────────────────────────────────────────
    const treeClickCommand = vscode.commands.registerCommand(
        'r-xpath-generator.generateFromTree',
        async (el: ParsedElement) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }

            const xpaths = generateXPaths(el);
            const result: ElementResult = { element: el, xpaths, selectionIndex: 0 };

            // Highlight element in source if we have position info
            if (el.sourceStart !== undefined && el.sourceEnd !== undefined) {
                const startPos = editor.document.positionAt(el.sourceStart);
                const endPos = editor.document.positionAt(el.sourceEnd);
                editor.selection = new vscode.Selection(startPos, endPos);
                editor.revealRange(new vscode.Range(startPos, endPos), vscode.TextEditorRevealType.InCenter);
            }

            const dummySelection = editor.selection;
            await showXPathQuickPick([result], [dummySelection], editor, context);
        }
    );

    // ── Refresh tree command ──────────────────────────────────────────────────
    const refreshTreeCommand = vscode.commands.registerCommand(
        'r-xpath-generator.refreshTree',
        () => {
            const doc = vscode.window.activeTextEditor?.document;
            if (doc) { treeProvider.refresh(doc); }
        }
    );

    // ── Export command ────────────────────────────────────────────────────────
    const exportCommand = vscode.commands.registerCommand(
        'r-xpath-generator.exportXPaths',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showErrorMessage('No active editor found'); return; }

            const selections = editor.selections.filter(s => !s.isEmpty);
            if (selections.length === 0) {
                vscode.window.showErrorMessage('Please select one or more HTML blocks to export');
                return;
            }

            const framework = getFramework(context);
            const allResults: ElementResult[] = [];

            for (let si = 0; si < selections.length; si++) {
                const selectionText = editor.document.getText(selections[si]);
                if (!selectionText.trim()) { continue; }

                const roots = parseHTML(selectionText);
                const allElements = flattenTree(roots);
                for (const target of pickAllTargets(allElements)) {
                    allResults.push({ element: target, xpaths: generateXPaths(target), selectionIndex: si });
                }
            }

            if (allResults.length === 0) { vscode.window.showErrorMessage('No elements found to export'); return; }
            await exportResults(allResults, framework);
        }
    );

    // ── Set Framework command ─────────────────────────────────────────────────
    const frameworkCommand = vscode.commands.registerCommand(
        'r-xpath-generator.setFramework',
        async () => {
            const options = [
                { label: '🐍 Selenium Python',      value: 'selenium-python' },
                { label: '☕ Selenium Java',         value: 'selenium-java' },
                { label: '🎭 Playwright TypeScript', value: 'playwright-ts' },
                { label: '🎭 Playwright Python',     value: 'playwright-python' },
                { label: '🌲 Cypress',               value: 'cypress' },
            ];

            const picked = await vscode.window.showQuickPick(
                options.map(o => ({ label: o.label, value: o.value })),
                { placeHolder: 'Select your test automation framework', title: 'Set Framework' }
            );

            if (!picked) { return; }
            const config = vscode.workspace.getConfiguration('rXpathGenerator');
            await config.update('framework', (picked as any).value, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`✅ Framework set to: ${picked.label}`);
        }
    );

    context.subscriptions.push(
        generateCommand,
        previewCommand,
        treeClickCommand,
        refreshTreeCommand,
        exportCommand,
        frameworkCommand
    );
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

export function deactivate() {}
