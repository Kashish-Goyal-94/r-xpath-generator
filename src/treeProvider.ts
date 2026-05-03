import * as vscode from 'vscode';
import {
    ParsedElement, parseHTML, flattenTree,
    isDynamic, isUtilityClass, ACTIONABLE_TAGS
} from './extension';

// ─── Tree Item ────────────────────────────────────────────────────────────────

export class ElementTreeItem extends vscode.TreeItem {
    constructor(
        public readonly element: ParsedElement,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly docUri: vscode.Uri
    ) {
        super(ElementTreeItem.buildLabel(element), collapsibleState);

        this.description = ElementTreeItem.buildDescription(element);
        this.tooltip = ElementTreeItem.buildTooltip(element);
        this.iconPath = ElementTreeItem.buildIcon(element);
        this.contextValue = 'htmlElement';

        // Click → generate XPath for this element
        this.command = {
            command: 'r-xpath-generator.generateFromTree',
            title: 'Generate XPath',
            arguments: [element],
        };
    }

    private static buildLabel(el: ParsedElement): string {
        let label = `<${el.tag}`;
        if (el.id)              { label += `#${el.id}`; }
        else if (el.classes.length) {
            const stable = el.classes.find(c => !isDynamic(c) && !isUtilityClass(c));
            if (stable) { label += `.${stable}`; }
        }
        label += '>';
        return label;
    }

    private static buildDescription(el: ParsedElement): string {
        const parts: string[] = [];
        if (el.name)          { parts.push(`name="${el.name}"`); }
        if (el.type)          { parts.push(`type="${el.type}"`); }
        if (el.placeholder)   { parts.push(`placeholder="${el.placeholder}"`); }
        if (el.textContent)   { parts.push(`"${el.textContent.slice(0, 30)}"`); }
        return parts.join('  ');
    }

    private static buildTooltip(el: ParsedElement): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**\`<${el.tag}>\`**\n\n`);

        if (el.id)            { md.appendMarkdown(`- **id**: \`${el.id}\`\n`); }
        if (el.name)          { md.appendMarkdown(`- **name**: \`${el.name}\`\n`); }
        if (el.type)          { md.appendMarkdown(`- **type**: \`${el.type}\`\n`); }
        if (el.placeholder)   { md.appendMarkdown(`- **placeholder**: \`${el.placeholder}\`\n`); }
        if (el.classes.length) { md.appendMarkdown(`- **class**: \`${el.classes.join(' ')}\`\n`); }

        const testAttrs = ['data-testid', 'data-cy', 'data-qa', 'data-test'];
        for (const attr of testAttrs) {
            if (el.dataAttrs[attr]) { md.appendMarkdown(`- **${attr}**: \`${el.dataAttrs[attr]}\`\n`); }
        }
        if (el.ariaAttrs['aria-label']) {
            md.appendMarkdown(`- **aria-label**: \`${el.ariaAttrs['aria-label']}\`\n`);
        }
        if (el.textContent)   { md.appendMarkdown(`- **text**: \`${el.textContent}\`\n`); }

        md.appendMarkdown(`\n*Click to generate XPath*`);
        return md;
    }

    private static buildIcon(el: ParsedElement): vscode.ThemeIcon {
        // Actionable elements get distinct colours
        if (!ACTIONABLE_TAGS.includes(el.tag)) {
            return new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('symbolIcon.namespaceForeground'));
        }

        switch (el.tag) {
            case 'input':    return new vscode.ThemeIcon('symbol-field',    new vscode.ThemeColor('symbolIcon.fieldForeground'));
            case 'button':   return new vscode.ThemeIcon('symbol-event',    new vscode.ThemeColor('symbolIcon.eventForeground'));
            case 'a':        return new vscode.ThemeIcon('link',            new vscode.ThemeColor('textLink.foreground'));
            case 'select':   return new vscode.ThemeIcon('symbol-enum',     new vscode.ThemeColor('symbolIcon.enumForeground'));
            case 'textarea': return new vscode.ThemeIcon('symbol-string',   new vscode.ThemeColor('symbolIcon.stringForeground'));
            default:         return new vscode.ThemeIcon('symbol-property', new vscode.ThemeColor('symbolIcon.propertyForeground'));
        }
    }
}

// ─── Tree Provider ────────────────────────────────────────────────────────────

export class ElementTreeProvider implements vscode.TreeDataProvider<ElementTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ElementTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _roots: ParsedElement[] = [];
    private _docUri: vscode.Uri | undefined;

    // Filter state
    private _filterText: string = '';

    public refresh(document: vscode.TextDocument) {
        const langId = document.languageId;
        if (!['html', 'xml', 'javascriptreact', 'typescriptreact'].includes(langId)) {
            this._roots = [];
            this._docUri = undefined;
            this._onDidChangeTreeData.fire();
            return;
        }

        this._docUri = document.uri;
        this._roots = parseHTML(document.getText(), 0);
        this._onDidChangeTreeData.fire();
    }

    public setFilter(text: string) {
        this._filterText = text.toLowerCase().trim();
        this._onDidChangeTreeData.fire();
    }

    public clearFilter() {
        this._filterText = '';
        this._onDidChangeTreeData.fire();
    }

    // ── TreeDataProvider implementation ───────────────────────────────────────

    getTreeItem(item: ElementTreeItem): vscode.TreeItem {
        return item;
    }

    getChildren(item?: ElementTreeItem): ElementTreeItem[] {
        if (!this._docUri) { return []; }

        const children = item ? item.element.children : this._roots;

        return children
            .filter(el => this._matchesFilter(el))
            .map(el => {
                const hasVisibleChildren = el.children.some(c => this._matchesFilter(c));
                const state = el.children.length > 0
                    ? (ACTIONABLE_TAGS.includes(el.tag) || hasVisibleChildren
                        ? vscode.TreeItemCollapsibleState.Expanded
                        : vscode.TreeItemCollapsibleState.Collapsed)
                    : vscode.TreeItemCollapsibleState.None;

                return new ElementTreeItem(el, state, this._docUri!);
            });
    }

    private _matchesFilter(el: ParsedElement): boolean {
        if (!this._filterText) { return true; }

        const q = this._filterText;
        if (q.startsWith('#')) {
            return !!(el.id && el.id.toLowerCase().includes(q.slice(1)));
        }
        if (q.startsWith('.')) {
            return el.classes.some(c => c.toLowerCase().includes(q.slice(1)));
        }

        return (
            el.tag.includes(q) ||
            !!(el.id && el.id.toLowerCase().includes(q)) ||
            !!(el.name && el.name.toLowerCase().includes(q)) ||
            !!(el.textContent && el.textContent.toLowerCase().includes(q)) ||
            !!(el.placeholder && el.placeholder.toLowerCase().includes(q)) ||
            el.classes.some(c => c.toLowerCase().includes(q)) ||
            Object.values(el.dataAttrs).some(v => v.toLowerCase().includes(q))
        );
    }

    // ── Flat actionable-only view (for quick navigation) ─────────────────────

    public getActionableItems(): ElementTreeItem[] {
        if (!this._docUri) { return []; }
        const allElements = flattenTree(this._roots);
        return allElements
            .filter(el => ACTIONABLE_TAGS.includes(el.tag))
            .map(el => new ElementTreeItem(el, vscode.TreeItemCollapsibleState.None, this._docUri!));
    }
}
