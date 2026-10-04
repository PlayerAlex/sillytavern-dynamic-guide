'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

function settingsHost(settings = {}) {
    const state = { settings, saves: 0, persisted: JSON.parse(JSON.stringify(settings)) };
    const context = {
        extensionSettings: settings,
        saveSettingsDebounced() { state.saves += 1; state.persisted = plain(settings); },
    };
    return { state, context, SillyTavern: { getContext: () => context } };
}

function load(helper, extra) {
    const logs = [];
    const errors = [];
    const sandbox = {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        TavernHelper: helper,
        SillyTavern: settingsHost().SillyTavern,
    };
    Object.assign(sandbox, extra || {});
    vm.runInNewContext(source, sandbox, { filename: 'index.js' });
    return { core: sandbox.DynamicGuideAssistantCore, logs, errors };
}

const { core } = load();
const plain = value => JSON.parse(JSON.stringify(value));
const lastUserText = request => {
    const segments = (request.ordered_prompts || []).filter(item => item && item.role === 'user');
    return segments.length ? String(segments[segments.length - 1].content) : '';
};

function helperFor(entry) {
    const state = {
        events: new Map(),
        injected: [],
        injectionOptions: [],
        active: new Map(),
        removed: [],
        variables: {
            character: { $dynamicGuideAssistant: { config: { worldbookName: '测试世界书', entryUid: 1, entryName: '大纲' } } },
            chat: {},
        },
        entries: [entry],
    };
    const helper = {
        tavern_events: { GENERATION_AFTER_COMMANDS: 'generate', CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received' },
        eventOn: (event, listener) => state.events.set(event, listener),
        getVariables: ({ type }) => state.variables[type],
        updateVariablesWith: (updater, { type }) => { state.variables[type] = updater(state.variables[type]); },
        getWorldbook: () => state.entries,
        updateWorldbookWith: (_name, updater) => { state.entries = updater(state.entries); },
        injectPrompts: (prompts, options) => prompts.forEach(prompt => {
            state.injected.push(prompt);
            state.injectionOptions.push(options || null);
            state.active.set(prompt.id, prompt);
        }),
        uninjectPrompts: ids => ids.forEach(id => {
            state.removed.push(id);
            state.active.delete(id);
        }),
    };
    return { state, helper };
}

// 手机端回归：魔法棒菜单的触摸事件必须同步显示整屏管理页。
function element(tag, registry) {
    const node = {
        nodeType: 1,
        tagName: String(tag).toUpperCase(),
        children: [],
        attributes: {},
        listeners: {},
        style: {
            setProperty(name, value) {
                this[name] = String(value);
            },
        },
        hidden: false,
        className: '',
        focus() {},
        setAttribute(name, value) {
            this.attributes[name] = String(value);
            if (name === 'hidden') this.hidden = true;
            if (name === 'id') {
                this.id = String(value);
                registry.set(this.id, this);
            }
        },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
        },
        removeAttribute(name) {
            delete this.attributes[name];
            if (name === 'hidden') this.hidden = false;
        },
        addEventListener(type, listener) {
            this.listeners[type] = (this.listeners[type] || []).concat(listener);
        },
        append(...items) {
            items.forEach(item => {
                if (!item) return;
                // 真浏览器的 append 可以直接收字符串。
                if (typeof item === 'string') item = { nodeType: 3, __text: true, textContent: item };
                item.parentNode = this;
                this.children.push(item);
                if (item.id) registry.set(item.id, item);
            });
        },
        appendChild(item) {
            this.append(item);
            return item;
        },
        replaceChildren(...items) {
            this.children = [];
            this.append(...items);
        },
        removeChild(item) {
            this.children = this.children.filter(child => child !== item);
            item.parentNode = null;
            return item;
        },
        querySelector(selector) {
            return findClass(this, selector.replace(/^\./, ''), true);
        },
        get textContent() {
            if (this.__text) return this.text;
            return this.children.map(child => child.textContent).join('');
        },
        set textContent(value) {
            this.children = [];
            this.__text = true;
            this.text = String(value);
        },
    };
    node.classList = {
        toggle(name, force) {
            const classes = new Set(String(node.className).split(/\s+/).filter(Boolean));
            const want = force === undefined ? !classes.has(name) : Boolean(force);
            if (want) classes.add(name);
            else classes.delete(name);
            node.className = Array.from(classes).join(' ');
            return want;
        },
        add(name) {
            this.toggle(name, true);
        },
        remove(name) {
            this.toggle(name, false);
        },
        contains: name => String(node.className).split(/\s+/).includes(name),
    };
    return node;
}

function nodeClassNames(node) {
    const fromName = typeof node.className === 'string' ? node.className : '';
    const fromAttr = node.attributes && node.attributes.class ? String(node.attributes.class) : '';
    return `${fromName} ${fromAttr}`.split(/\s+/).filter(Boolean);
}

function findClass(node, name, skipSelf) {
    if (!skipSelf && nodeClassNames(node).includes(name)) return node;
    for (const child of node.children || []) {
        const found = findClass(child, name, false);
        if (found) return found;
    }
    return null;
}

function findAllClass(node, name, out = []) {
    if (nodeClassNames(node).includes(name)) out.push(node);
    (node.children || []).forEach(child => findAllClass(child, name, out));
    return out;
}

function fakeDocument(html) {
    const registry = new Map();
    const documentRef = {
        head: element('head', registry),
        body: element('body', registry),
        createElement: tag => element(tag, registry),
        // 真浏览器的 SVG：className 是只读对象，赋值会抛错。setAttribute('class') 仍然生效。
        createElementNS: (_namespace, tag) => {
            const node = element(tag, registry);
            const animated = { baseVal: '' };
            Object.defineProperty(node, 'className', {
                configurable: true,
                get() { return animated; },
                set() {
                    throw new TypeError('Cannot set property className of #<SVGElement> which has only a getter');
                },
            });
            const setAttribute = node.setAttribute.bind(node);
            node.setAttribute = (name, value) => {
                setAttribute(name, value);
                if (name === 'class') animated.baseVal = String(value);
            };
            return node;
        },
        createTextNode: text => ({ nodeType: 3, __text: true, textContent: String(text) }),
        getElementById: id => registry.get(id) || null,
        querySelector: () => null,
    };
    documentRef.documentElement = element('html', registry);
    documentRef.documentElement.appendChild(documentRef.head);
    documentRef.documentElement.appendChild(documentRef.body);
    if (html.includes('extensionsMenu')) {
        const menu = element('div', registry);
        menu.setAttribute('id', 'extensionsMenu');
        documentRef.body.appendChild(menu);
        const button = element('button', registry);
        button.setAttribute('id', 'extensionsMenuButton');
        documentRef.body.appendChild(button);
    }
    return documentRef;
}

function loadWithDocument(documentRef, helper) {
    const logs = [];
    const errors = [];
    const sandbox = {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        TavernHelper: helper,
        document: documentRef,
        SillyTavern: settingsHost().SillyTavern,
        getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
        setTimeout: () => 0,
        setInterval: () => 0,
        clearInterval: () => {},
        innerWidth: 390,
        innerHeight: 844,
        matchMedia: query => ({ matches: query === '(pointer: coarse)' }),
    };
    vm.runInNewContext(source, sandbox, { filename: 'index.js' });
    return { logs, errors, sandbox };
}

function loadWithNestedDocuments(topDocument, frameDocument, helper) {
    const logs = [];
    const errors = [];
    const topWindow = {
        document: topDocument,
        SillyTavern: settingsHost().SillyTavern,
        getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
        setTimeout: () => 0,
        innerWidth: 390,
        innerHeight: 844,
        matchMedia: query => ({ matches: query === '(pointer: coarse)' }),
    };
    topWindow.top = topWindow;
    topWindow.parent = topWindow;
    const frameWindow = {
        document: frameDocument,
        top: topWindow,
        parent: topWindow,
        TavernHelper: helper,
    };
    const sandbox = {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        window: frameWindow,
    };
    vm.runInNewContext(source, sandbox, { filename: 'index.js' });
    return { logs, errors, sandbox, topWindow, frameWindow };
}

const touchEntry = async entry => {
    const event = { target: entry, preventDefault() {}, stopPropagation() {} };
    entry.listeners.pointerup[0](event);
    await new Promise(setImmediate);
};

const PANEL_ID = 'dynamic-guide-assistant-panel';

test('手机触摸魔法棒入口会立即打开全屏管理页', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const { errors } = loadWithDocument(documentRef, helper);
    const entry = documentRef.getElementById('dynamic-guide-assistant-menu-item');
    assert.ok(entry, '应当注册魔法棒菜单入口');
    assert.ok(entry.listeners.pointerup, '应当监听手机指针抬起');
    assert.ok(entry.listeners.touchend, '应当兼容旧手机触摸结束');
    assert.equal(documentRef.getElementById(PANEL_ID), null, '加载时不提前把面板挂进脚本 iframe');
    const pending = touchEntry(entry);
    const panel = documentRef.getElementById(PANEL_ID);
    assert.ok(panel, '触摸入口时才在主页面创建面板');
    assert.equal(panel.hidden, false, '触摸事件返回前就要显示管理页');
    const shell = panel.querySelector('.dga-shell');
    assert.ok(shell, '管理页要渲染进面板');
    assert.equal(shell.style.height, '100%', '手机端使用整屏高度');
    assert.equal(shell.style['max-width'], 'none', '手机端不显示成居中小窗口');
    await pending;
    assert.equal(panel.hidden, false);
    assert.deepEqual(errors, []);
});

test('脚本在嵌套 iframe 运行时，入口和面板都挂到含魔法棒的主页面', async () => {
    const topDocument = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const frameDocument = fakeDocument('<body></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const { errors } = loadWithNestedDocuments(topDocument, frameDocument, helper);
    const entry = topDocument.getElementById('dynamic-guide-assistant-menu-item');
    assert.ok(entry, '入口应创建在主页面');
    assert.equal(frameDocument.getElementById('dynamic-guide-assistant-menu-item'), null);
    const pending = touchEntry(entry);
    const panel = topDocument.getElementById(PANEL_ID);
    assert.ok(panel, '面板应创建在主页面');
    assert.equal(frameDocument.getElementById(PANEL_ID), null, '脚本 iframe 内不应创建小面板');
    assert.equal(panel.hidden, false);
    await pending;
    assert.deepEqual(errors, []);
});

test('跨域顶层窗口不会阻止同源页面注册入口', () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const crossOriginTop = new Proxy({}, {
        get() {
            throw new Error('SecurityError: cross-origin access denied');
        },
        set() {
            throw new Error('SecurityError: cross-origin access denied');
        },
    });
    const frameWindow = {
        document: documentRef,
        parent: null,
        top: crossOriginTop,
        TavernHelper: helper,
        getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
        setTimeout: () => 0,
        innerWidth: 390,
        innerHeight: 844,
        matchMedia: query => ({ matches: query === '(pointer: coarse)' }),
    };
    frameWindow.parent = frameWindow;
    const logs = [];
    const errors = [];
    vm.runInNewContext(source, {
        Buffer,
        console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => errors.push(message) },
        window: frameWindow,
    }, { filename: 'index.js' });
    assert.ok(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    assert.ok(documentRef.getElementById('dynamic-guide-assistant-style'), '入口注册时应同时安装手机触摸样式');
    assert.deepEqual(errors, []);
});

test('魔法棒入口沿用酒馆原生条目结构，图标主题样式不会走样', () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const { errors } = loadWithDocument(documentRef, helper);
    const entry = documentRef.getElementById('dynamic-guide-assistant-menu-item');
    assert.ok(entry, '应当注册魔法棒菜单入口');
    assert.equal(entry.className, 'extension_container', '外层必须是 extension_container');
    const row = entry.children[0];
    assert.match(row.className, /list-group-item/, '内层必须是 list-group-item');
    assert.match(row.className, /interactable/);
    const icon = row.children[0];
    assert.equal(icon.tagName, 'DIV', '图标要和酒馆自带条目一样是 div');
    assert.match(icon.className, /extensionsMenuExtensionButton/);
    assert.deepEqual(errors, []);
});

test('面板高度写死成视口高度，不再靠 inset 定位', () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    loadWithDocument(documentRef, helper);
    const style = documentRef.getElementById('dynamic-guide-assistant-style');
    assert.ok(style, '应当安装面板样式');
    const css = style.textContent;
    assert.match(css, /height:\s*100vh/, '要有 100vh 兜底');
    assert.match(css, /height:\s*100dvh/, '手机要用 100dvh 撑满');
    assert.match(css, /max-height:\s*100dvh/);
    assert.doesNotMatch(css, /position:\s*fixed;\s*inset:\s*0/, '单独用 inset 定位会在手机上算出 0 高度');
    assert.match(css, /\.dga-rail \{[^}]*width:\s*220px/, '电脑左侧目录宽 220');
    assert.match(css, /\.dga-nav-toggle \{ display: none; \}/, '电脑上藏起左上角 ☰');
    assert.match(css, /max-width:\s*720px\) \{\s*#dynamic-guide-assistant-panel \.dga-rail \{ display: none; \}/, '窄屏才收起左侧目录');
    assert.match(css, /min-width:\s*861px\) \{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, '宽屏卡片两列');
});

// ---------------------------------------------------------------
// v2.1 多绑定：每条绑定各自注入、各自推进、可以单独移出
// ---------------------------------------------------------------

function multiWorld(books, options) {
    const settings = options || {};
    const state = {
        events: new Map(),
        injected: [],
        injectionOptions: [],
        active: new Map(),
        removed: [],
        variables: {
            character: { $dynamicGuideAssistant: { config: settings.config || { version: 2, bindings: [] } } },
            chat: settings.chatState ? { $dynamicGuideAssistant: { state: settings.chatState } } : {},
        },
        books,
        messages: settings.messages || [],
        lastMessageId: settings.lastMessageId == null ? null : settings.lastMessageId,
    };
    const helper = {
        tavern_events: { GENERATION_AFTER_COMMANDS: 'generate', CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received' },
        eventOn: (event, listener) => state.events.set(event, listener),
        getVariables: ({ type }) => state.variables[type],
        updateVariablesWith: (updater, { type }) => { state.variables[type] = updater(state.variables[type]); },
        getWorldbookNames: () => Object.keys(state.books),
        getWorldbook: name => state.books[name],
        updateWorldbookWith: (name, updater) => { state.books[name] = updater(state.books[name]); },
        injectPrompts: (prompts, options) => prompts.forEach(prompt => {
            state.injected.push(prompt);
            state.injectionOptions.push(options || null);
            state.active.set(prompt.id, prompt);
        }),
        uninjectPrompts: ids => ids.forEach(id => {
            state.removed.push(id);
            state.active.delete(id);
        }),
        getLastMessageId: () => state.lastMessageId,
        getChatMessages: id => {
            if (typeof id === 'string' && id.includes('-')) {
                const [from, to] = id.split('-').map(Number);
                return state.messages.filter(message => message.message_id >= from && message.message_id <= to);
            }
            return state.messages.filter(message => message.message_id === id);
        },
        setChatMessages: updates => {
            updates.forEach(update => {
                const message = state.messages.find(item => item.message_id === update.message_id);
                if (message) message.message = update.message;
            });
        },
    };
    return { state, helper };
}

const keyOf = (worldbookName, uid) => `${worldbookName}#uid:${uid}`;

function findButton(node, prefix) {
    if (node.tagName === 'BUTTON' && String(node.textContent || '').includes(prefix)) return node;
    for (const child of node.children || []) {
        const found = findButton(child, prefix);
        if (found) return found;
    }
    return null;
}

test('本机判断AI API 预设：连接方式、接口协议与数值字段', () => {
    assert.deepEqual(plain(core.normalizeJudgeApiPreset({
        name: ' 自定义判断AI ', connection: 'custom', customApiFormat: 'claude_messages',
        apiurl: ' https://api.example.com/v1 ', key: 'sk-x', model: ' m1 ',
        maxTokens: '24', temperature: '0.3', bodyParams: 'top_k: 50',
    })), {
        name: '自定义判断AI', connection: 'custom', customApiFormat: 'claude_messages',
        apiurl: 'https://api.example.com/v1', key: 'sk-x', model: 'm1',
        maxTokens: 24, temperature: 0.3, bodyParams: 'top_k: 50',
        excludeBodyParams: '', requestHeaders: '', promptPostProcessing: 'strict',
    });
});

test('API 预设请求体：Claude 协议映射原生源并规范基址', () => {
    const preset = core.normalizeJudgeApiPreset({
        name: '克劳德', connection: 'custom', customApiFormat: 'claude_messages',
        apiurl: 'https://api.anthropic.com', key: 'sk-ant', model: 'claude-sonnet',
        maxTokens: 24, temperature: 0.3, bodyParams: 'top_k: 50', excludeBodyParams: 'top_p, reasoning_effort',
        requestHeaders: 'X-Extra: 1', promptPostProcessing: '',
    });
    const body = core.buildJudgeCustomRequestBody([{ role: 'SYSTEM', content: 's' }, { role: 'user', content: 'u' }], preset);
    assert.equal(body.chat_completion_source, 'claude');
    assert.equal(body.reverse_proxy, 'https://api.anthropic.com/v1', 'claude 源基址要补 /v1');
    assert.equal(body.proxy_password, 'sk-ant', '原生源密钥走 proxy_password');
    assert.equal(body.custom_url, 'https://api.anthropic.com');
    assert.equal(body.custom_include_headers, 'Authorization: Bearer sk-ant\nX-Extra: 1');
    assert.equal(body.custom_include_body, 'top_k: 50');
    assert.equal(body.custom_exclude_body, '- top_p\n- reasoning_effort');
    assert.equal('custom_prompt_post_processing' in body, false, '显式「未选择」时不带该字段');
    assert.equal(body.messages[0].role, 'system', 'role 统一小写');
    assert.equal(body.max_tokens, 24);
    assert.equal(body.temperature, 0.3);
});

test('API 预设请求体：OpenAI 兼容协议走 custom 源', () => {
    const preset = core.normalizeJudgeApiPreset({
        name: 'o', connection: 'custom', customApiFormat: 'openai_compat',
        apiurl: 'https://api.example.com/v1', key: 'k', model: 'models/gpt-x',
    });
    const body = core.buildJudgeCustomRequestBody([{ role: 'user', content: 'q' }], preset);
    assert.equal(body.chat_completion_source, 'custom');
    assert.equal(body.reverse_proxy, 'https://api.example.com/v1');
    assert.equal(body.proxy_password, '', 'custom 源不用 proxy_password');
    assert.equal(body.model, 'gpt-x', 'models/ 前缀要剥掉');
    assert.equal(body.custom_prompt_post_processing, 'strict', '缺省归一为严格');
    assert.equal(body.max_tokens, 60000, '缺省最大回复长度 60000');
    assert.equal(body.temperature, 1, '缺省温度 1');
});

test('本机判断AI API 预设：缺省数值回退默认 60000 / 1', () => {
    const preset = plain(core.normalizeJudgeApiPreset({ name: '裸预设', connection: 'main' }));
    assert.equal(preset.maxTokens, 60000, '最大回复长度缺省 60000');
    assert.equal(preset.temperature, 1, '温度缺省 1');
    const broken = plain(core.normalizeJudgeApiPreset({ name: '坏数值', connection: 'main', maxTokens: 'abc', temperature: 'x' }));
    assert.equal(broken.maxTokens, 60000, '非法值也回退 60000');
    assert.equal(broken.temperature, 1, '非法温度回退 1');
});

test('提示词后处理归一化：空串保留、非法回退严格', () => {
    assert.equal(core.normalizePromptPostProcessing(''), '');
    assert.equal(core.normalizePromptPostProcessing('strict'), 'strict');
    assert.equal(core.normalizePromptPostProcessing('merge_tools'), 'merge_tools');
    assert.equal(core.normalizePromptPostProcessing(undefined), 'strict');
    assert.equal(core.normalizePromptPostProcessing('junk'), 'strict');
});

test('排除主体参数归一化：逗号/换行转 YAML 序列，YAML 原样透传', () => {
    assert.equal(core.normalizeExcludeBodyParams('top_p, reasoning_effort'), '- top_p\n- reasoning_effort');
    assert.equal(core.normalizeExcludeBodyParams('top_p\nreasoning_effort'), '- top_p\n- reasoning_effort');
    assert.equal(core.normalizeExcludeBodyParams('- top_p\n- reasoning_effort'), '- top_p\n- reasoning_effort');
    assert.equal(core.normalizeExcludeBodyParams(''), '');
    assert.equal(core.normalizeExcludeBodyParams(null), '');
});

test('原生协议源基址归一化：claude 补 /v1、makersuite 剥版本段', () => {
    assert.equal(core.normalizeNativeProxyBase('https://api.anthropic.com', 'claude'), 'https://api.anthropic.com/v1');
    assert.equal(core.normalizeNativeProxyBase('https://api.anthropic.com/v1/', 'claude'), 'https://api.anthropic.com/v1');
    assert.equal(core.normalizeNativeProxyBase('https://gw.example.com/claude/messages', 'claude'), 'https://gw.example.com/claude/v1');
    assert.equal(core.normalizeNativeProxyBase('https://generativelanguage.googleapis.com/v1beta', 'makersuite'), 'https://generativelanguage.googleapis.com');
    assert.equal(core.normalizeNativeProxyBase('', 'claude'), '');
});

test('拉模型走酒馆后端 status 端点并解析 models 列表', async () => {
    const fetches = [];
    const fetchMock = async (url, options) => {
        fetches.push({ url, options });
        return { ok: true, json: async () => ({ models: [{ id: 'm1' }, { id: 'm2' }, 'm3'] }), text: async () => '' };
    };
    const run = load(null, { fetch: fetchMock });
    const models = await run.core.fetchAvailableModels('https://api.example.com/v1', 'sk-x');
    assert.deepEqual(models, ['m1', 'm2', 'm3']);
    assert.equal(fetches[0].url, '/api/backends/chat-completions/status');
    const body = JSON.parse(fetches[0].options.body);
    assert.equal(body.chat_completion_source, 'custom');
    assert.equal(body.custom_url, 'https://api.example.com/v1');
    assert.equal(body.custom_include_headers, 'Authorization: Bearer sk-x');
});

test('拉模型失败时抛出带状态的错误，空端点直接拒绝', async () => {
    const fetchMock = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":"bad key"}' });
    const run = load(null, { fetch: fetchMock });
    await assert.rejects(() => run.core.fetchAvailableModels('https://x', 'k'), /401/);
    await assert.rejects(() => run.core.fetchAvailableModels('', 'k'), /请输入端点/);
});

test('normalizeConfig 清除旧引擎、完整预设和已退役的本机预设名', () => {
    const normalized = core.normalizeConfig({
        version: 2,
        bindings: [],
        settings: {
            judgeEngine: 'callAI',
            judgeApiPresets: [{ name: '旧数据库预设' }],
            judgePreset: '本机预设',
        },
    });
    assert.equal('judgePreset' in normalized.settings, false);
    assert.equal('judgeEngine' in normalized.settings, false);
    assert.equal('judgeApiPresets' in normalized.settings, false);
});

test('预设迁移：旧的酒馆预设（tavern / type=proxy）改走酒馆主 API，type=current → main', () => {
    const list = core.normalizeJudgeApiPresets([
        { name: '代理', type: 'proxy', proxyPreset: '酒馆代理A', model: 'm' },
        { name: '主 API', type: 'current' },
        { name: '走酒馆预设', connection: 'tavern', tavernProfile: 'p1' },
    ]);
    assert.equal(list[0].connection, 'main');
    assert.equal(list[1].connection, 'main');
    assert.equal(list[2].connection, 'main', 'v3.7.1 起不再有酒馆预设连接');
});


// ---------------------------------------------------------------
// v2.13：输出提取/排除规则 + 运行日志
// ---------------------------------------------------------------

test('规则归一化：去空白、丢残缺项与非对象项、去重', () => {
    const rules = core.normalizeRulePairs([
        { start: ' <a> ', end: ' </a> ' },
        { start: '', end: 'x' },
        { start: 'y' },
        '字符串项',
        null,
        { start: '<a>', end: '</a>' },
        { start: '<b>', end: '</b>' },
    ]);
    assert.deepEqual(plain(rules), [{ start: '<a>', end: '</a>' }, { start: '<b>', end: '</b>' }]);
});

test('提取规则：取最后一处命中且含边界，多条拼接，未命中回退原文', () => {
    const text = '闲聊\n<结论>YES</结论>\n中间\n<结论>NO</结论>\n尾巴';
    const once = core.applyJudgeOutputRules(text, { extractRules: [{ start: '<结论>', end: '</结论>' }] });
    assert.equal(once, '<结论>NO</结论>', '取最后一处命中（含边界本身）');
    const miss = core.applyJudgeOutputRules(text, { extractRules: [{ start: '<没有>', end: '</没有>' }] });
    assert.equal(miss, text, '一条都没命中就返回原文');
    const multi = core.applyJudgeOutputRules('前<a>1</a>中<b>2</b>后', {
        extractRules: [{ start: '<a>', end: '</a>' }, { start: '<b>', end: '</b>' }],
    });
    assert.equal(multi, '<a>1</a>\n\n<b>2</b>', '多条规则的结果用空行拼接');
});

test('排除规则：删区间含边界、支持嵌套、压空行、不区分大小写', () => {
    const nested = '开头\n<think>第一层<think>第二层</think>结束</think>\n\n\n\n结尾';
    const out = core.applyJudgeOutputRules(nested, { excludeRules: [{ start: '<think>', end: '</think>' }] });
    assert.equal(out, '开头\n\n结尾', '嵌套区间整体删除，3 个以上换行压成 2 个');
    const ci = core.applyJudgeOutputRules('前<Think>x</THINK>后', { excludeRules: [{ start: '<think>', end: '</think>' }] });
    assert.equal(ci, '前后', '边界匹配不区分大小写');
    assert.equal(core.applyJudgeOutputRules(nested, {}), nested, '没有规则 = 原文直通');
});

test('先提取后排除', () => {
    const out = core.applyJudgeOutputRules('噪音<a>保留<cut>删我</cut>就好</a>噪音', {
        extractRules: [{ start: '<a>', end: '</a>' }],
        excludeRules: [{ start: '<cut>', end: '</cut>' }],
    });
    assert.equal(out, '<a>保留就好</a>');
});

test('运行日志：写入字段完整、标签收集、清空', () => {
    const run = load();
    const log = run.core.log;
    log._resetForTesting();
    log.info('判断AI', '结论：YES');
    log.warn('提醒', '预设丢失');
    log.error('API', '拉取失败', new Error('boom'));
    const all = log.list();
    assert.equal(all.length, 3);
    assert.deepEqual([...all].map(entry => entry.level), ['info', 'warn', 'error']);
    assert.equal(all[0].tag, '判断AI');
    assert.match(all[2].message, /Error: boom/);
    assert.ok(all.every(entry => entry.id > 0 && entry.time > 0), '每条都要有自增 id 和时间戳');
    assert.deepEqual(plain(log.tags()), ['API', '提醒', '判断AI'].sort());
    log.clear();
    assert.equal(log.count(), 0);
});

test('运行日志：debug 默认不采集，开启后采集；订阅实时通知、退订生效', () => {
    const run = load();
    const log = run.core.log;
    log._resetForTesting();
    log.debug('同步', '镜像同步完成');
    assert.equal(log.count(), 0, 'debug 默认不写缓冲');
    const seen = [];
    const unsubscribe = log.subscribe(entry => seen.push(entry));
    log.setDebugEnabled(true);
    log.debug('同步', '镜像同步完成');
    log.info('系统', '已加载');
    assert.equal(log.count(), 2);
    assert.deepEqual(seen.map(entry => entry.level), ['debug', 'info']);
    unsubscribe();
    log.info('系统', '再来一条');
    assert.equal(seen.length, 2, '退订后不再通知');
});

test('运行日志：环形缓冲超过 2000 条丢最旧', () => {
    const run = load();
    const log = run.core.log;
    log._resetForTesting();
    for (let index = 0; index < 2010; index += 1) log.info('测试', `第 ${index} 条`);
    assert.equal(log.count(), 2000);
    assert.equal(log.list()[0].message, '第 10 条', '最旧的 10 条必须被丢弃');
});

test('运行日志：错误对象带 stack 与 cause，循环引用对象不报错', () => {
    const run = load();
    const log = run.core.log;
    log._resetForTesting();
    const inner = new Error('底层超时');
    const outer = new Error('调用失败');
    outer.cause = inner;
    const loop = { a: 1 };
    loop.self = loop;
    log.error('API', outer, loop, undefined, null);
    const message = log.list()[0].message;
    assert.match(message, /^Error: 调用失败/);
    assert.match(message, /cause=Error: 底层超时/);
    assert.match(message, /Object\{a=1/);
    assert.match(message, /undefined null$/);
});

test('运行日志：错误处理建议按规则匹配，只给 error 级', () => {
    const run = load();
    const hint = run.core.resolveLogErrorHint;
    assert.equal(hint({ level: 'warn', tag: '判断AI', message: 'HTTP 429' }), null);
    assert.equal(hint({ level: 'error', tag: '判断AI', message: '调用失败：HTTP 429 Too Many Requests' }).id, 'http-429');
    assert.equal(hint({ level: 'error', tag: '判断AI', message: '401 Unauthorized' }).id, 'http-401');
    assert.equal(hint({ level: 'error', tag: '判断AI', message: 'Failed to fetch' }).id, 'network');
    assert.equal(hint({ level: 'error', tag: '判断AI', message: '找不到本机 API 预设「甲」' }).id, 'preset-missing');
    assert.equal(hint({ level: 'error', tag: '判断AI', message: '判断AI需要酒馆助手的 generateRaw 接口' }).id, 'tavern-helper');
    assert.equal(hint({ level: 'error', tag: '绑定', message: '世界书写入失败' }).id, 'worldbook');
    assert.equal(hint({ level: 'error', tag: '其他', message: '不明原因' }).id, 'generic', '通用兜底');
});

test('运行日志页：关键词搜索、暂停攒条数、按等级筛选、错误下面附处理建议', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const booted = loadWithDocument(documentRef, helper);
    const log = booted.sandbox.DynamicGuideAssistantCore.log;
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    log.error('判断AI', '调用失败：HTTP 429 Too Many Requests');
    log.info('推进', '甲一 → 甲二');
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '运行日志').listeners.click[0]();
    const hintNode = panel().querySelector('.dga-log-hint');
    assert.ok(hintNode, '错误日志下面要有处理建议');
    assert.match(hintNode.textContent, /可能是：.*限流.*可以这样做：/);
    assert.match(panel().querySelector('.dga-log-chips').textContent, /全部\d+错误1警告0信息\d+/, '等级按钮带条数');
    findButton(panel().querySelector('.dga-log-chips'), '错误').listeners.click[0]();
    assert.doesNotMatch(panel().querySelector('.dga-log-list').textContent, /甲一/, '只看错误');
    findButton(panel().querySelector('.dga-log-chips'), '全部').listeners.click[0]();
    const search = () => panel().querySelector('.dga-log-q');
    assert.ok(search(), '有关键词搜索框');
    search().listeners.change[0]({ target: { value: '甲一' } });
    assert.ok(!panel().querySelector('.dga-log-hint'), '搜索后只剩匹配的那条');
    assert.match(panel().textContent, /甲一 → 甲二/);
    findButton(panel(), '实时').listeners.click[0]();
    log.info('推进', '暂停期间来的');
    assert.match(panel().querySelector('.dga-live').textContent, /已暂停/, '暂停后按钮写着已暂停');
    assert.doesNotMatch(panel().textContent, /暂停期间来的/, '暂停时不显示新日志');
    findButton(panel(), '已暂停').listeners.click[0]();
    search().listeners.change[0]({ target: { value: '' } });
    assert.match(panel().textContent, /暂停期间来的/, '恢复后一次显示出来');
    assert.deepEqual(booted.errors, []);
});


// ---------------------------------------------------------------
// v2.14：规则在发送前过滤角色消息 + 输出留痕 + 规则预览
// ---------------------------------------------------------------

test('规则预览：changed / hasTag / yes 三个字段都正确', () => {
    const untouched = core.previewJudgeOutput('<结论>YES</结论>', {});
    assert.deepEqual(plain(untouched), { filtered: '<结论>YES</结论>', changed: false, yes: true, hasTag: true });
    const extracted = core.previewJudgeOutput('啰嗦\n<结论>NO</结论>\n尾巴', { extractRules: [{ start: '<结论>', end: '</结论>' }] });
    assert.equal(extracted.filtered, '<结论>NO</结论>');
    assert.equal(extracted.changed, true);
    assert.equal(extracted.yes, false);
    assert.equal(extracted.hasTag, true);
    const noTag = core.previewJudgeOutput('没有标签的普通回答', {});
    assert.equal(noTag.hasTag, false);
    assert.equal(noTag.yes, false);
    const empty = core.previewJudgeOutput('', { excludeRules: [{ start: '<a>', end: '</a>' }] });
    assert.equal(empty.filtered, '');
    assert.equal(empty.changed, false);
});

test('流式输出归一化：只认布尔，其余回退 false', () => {
    const on = core.normalizeConfig({ version: 2, bindings: [], settings: { streamingEnabled: true } });
    assert.equal(on.settings.streamingEnabled, true);
    const truthy = core.normalizeConfig({ version: 2, bindings: [], settings: { streamingEnabled: 'yes' } });
    assert.equal(truthy.settings.streamingEnabled, false, '非布尔真值也要回退 false');
    const off = core.normalizeConfig({ version: 2, bindings: [], settings: { streamingEnabled: 1 } });
    assert.equal(off.settings.streamingEnabled, false);
});

test('SSE 聚合：OpenAI delta、Claude content_block_delta、[DONE] 与噪声行', () => {
    const openai = 'data: {"choices":[{"delta":{"content":"<结"}}]}\n\ndata: {"choices":[{"delta":{"content":"论>YES</结"}}]}\n\ndata: {"choices":[{"delta":{"content":"论>"}}]}\n\ndata: [DONE]\n';
    assert.equal(core.parseJudgeSseText(openai), '<结论>YES</结论>');
    const claude = 'data: {"type":"content_block_delta","delta":{"text":"YES"}}\ndata: [DONE]\n';
    assert.equal(core.parseJudgeSseText(claude), 'YES');
    const noise = ': 心跳\n\ndata: 不是json\n\ndata: {"choices":[{"delta":{}}]}\n';
    assert.equal(core.parseJudgeSseText(noise), '', '噪声行不产生文本');
});

test('「导出」用的是宿主窗口，不再把窗口当函数调用', async () => {
    assert.doesNotMatch(source, /hostWindow\(\)/, 'hostWindow 是窗口对象，不是函数');
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const downloads = [];
    const createElement = documentRef.createElement;
    documentRef.createElement = tag => {
        const node = createElement(tag);
        if (String(tag).toLowerCase() === 'a') {
            node.click = () => downloads.push(node.getAttribute('download'));
            node.remove = () => { if (node.parentNode) node.parentNode.removeChild(node); };
        }
        return node;
    };
    const { helper } = helperFor({ uid: 1, name: '大纲', content: '## 第一幕\n正文', enabled: false });
    const booted = loadWithDocument(documentRef, helper);
    booted.sandbox.Blob = function Blob(parts, options) { this.parts = parts; this.options = options; };
    booted.sandbox.URL = { createObjectURL: () => 'blob:dga', revokeObjectURL: () => {} };
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    panel().querySelector('.dga-nav-toggle').listeners.click[0]();
    findButton(panel(), '运行日志').listeners.click[0]();
    findButton(panel(), '导出').listeners.click[0]();
    assert.equal(downloads.length, 1, '点「导出」要真的下载一份日志');
    assert.match(downloads[0], /^动态指导助手-运行日志-\d{8}-\d{4}\.txt$/);
    assert.deepEqual(booted.errors, []);
});


test('默认提示词迁移：和 v3.0 默认一字不差的段换成新默认，改过的段保留', () => {
    const run = load();
    const d = run.core.judgeDefaults;
    const old = [
        { role: 'system', content: d.legacyIdentity },
        { role: 'system', content: d.rules },
        { role: 'user', content: d.legacyCase },
    ];
    const migrated = plain(run.core.migrateJudgeSegments(old));
    assert.deepEqual(migrated, plain(d.segments), '全是旧默认时整组换成新默认');
    const custom = [
        { role: 'system', content: '我自己写的身份' },
        { role: 'system', content: d.rules },
        { role: 'user', content: d.legacyCase },
    ];
    const kept = plain(run.core.migrateJudgeSegments(custom));
    assert.equal(kept.length, 3, '身份改过就不合并');
    assert.equal(kept[0].content, '我自己写的身份');
    assert.match(kept[2].content, /\{\{elapsed\}\}/, '没改过的案卷段换成新默认');
});

// ---------------------------------------------------------------
// 路线图（v4.0）：一棵树一个条目
// ---------------------------------------------------------------

// 搭一棵小树：开场 → 路口（留下 / 离开）；离开走完接回「重逢」；开场上挂一条支线。
function demoRoute(R) {
    const route = R.makeRoute('海边书店');
    const start = route.root;
    route.nodes[start].name = '开场';
    route.nodes[start].content = '开场正文';
    const fork = R.addNode(route, '路口', '路口正文', '');
    R.connect(route, start, fork, '');
    const stay = R.addNode(route, '留下', '留下正文', '');
    const leave = R.addNode(route, '离开', '离开正文', '');
    const meet = R.addNode(route, '重逢', '重逢正文', '');
    R.connect(route, fork, stay, '{{user}}留下');
    R.connect(route, fork, leave, '{{user}}离开');
    R.connect(route, stay, meet, '');
    R.connect(route, leave, meet, '');
    const side = R.addSide(route, start, '夏日祭', '{{char}}约{{user}}去祭典', '邀约');
    route.nodes[side.root].content = '邀约正文';
    const fireworks = R.addNode(route, '烟火', '烟火正文', '', side.id);
    R.connect(route, side.root, fireworks, '');
    return { route, start, fork, stay, leave, meet, side, fireworks };
}

test('路线图：一段一段往下走，到路口要选，走完接回同一段，走到终点什么都不发', () => {
    const R = load().core.routes;
    const t = demoRoute(R);
    const state = R.normalizeRouteState(null, t.route);
    assert.equal(state.cur, t.start, '新聊天从起点开始');
    assert.equal(R.mainStep(t.route, state).kind, 'moved');
    assert.equal(state.cur, t.fork);
    const atFork = R.mainStep(t.route, state);
    assert.equal(atFork.kind, 'pick', '路口要选一条');
    assert.equal(state.cur, t.fork, '没选之前停在路口');
    R.mainGo(t.route, state, t.leave);
    const cls = R.classify(t.route, state);
    assert.equal(cls[t.leave], 'cur');
    assert.equal(cls[t.stay], 'dead', '没走的路变灰');
    assert.equal(cls[t.meet], 'open', '接回的那段还能走到');
    assert.equal(R.mainStep(t.route, state).kind, 'moved');
    assert.equal(state.cur, t.meet, '走完接回「重逢」');
    assert.equal(R.mainStep(t.route, state).kind, 'ended', '后面什么都没接就是终点');
    assert.equal(R.compose(t.route, state), '', '走到终点什么都不发');
    assert.equal(R.mainBack(t.route, state), true);
    assert.equal(state.ended, false, '上一段先回到终点那一段');
    assert.equal(R.mainBack(t.route, state), true);
    assert.equal(state.cur, t.leave, '沿着实际走过的那一路往回退');
    assert.equal(R.jumpTo(t.route, state, t.stay), true);
    assert.deepEqual(plain(state.hist), [t.start, t.fork], '从这里接着走：补齐从起点过来的路');
});

test('路线图：支线和主线同时走，等它、主线到了某段就结束', () => {
    const R = load().core.routes;
    const t = demoRoute(R);
    const state = R.normalizeRouteState(null, t.route);
    assert.deepEqual(plain(R.offeredSides(t.route, state).map(side => side.name)), ['夏日祭'], '主线在挂支线的那段时可以开始');
    R.sideStart(t.route, state, t.side);
    assert.equal(R.compose(t.route, state), '开场正文', '没放支线格子时，模板只发主线');
    t.route.blocks.push({ id: 'k1', when: `side:${t.side.id}`, text: `祭典：⟦side:${t.side.id}⟧` });
    assert.equal(R.compose(t.route, state), '开场正文\n\n祭典：邀约正文', '支线开始以后和主线一起发');
    R.mainStep(t.route, state);
    assert.equal(state.cur, t.fork, '主线照常往下走');
    assert.equal(R.sideStep(t.route, state, t.side).kind, 'moved');
    assert.equal(R.compose(t.route, state), '路口正文\n\n祭典：烟火正文');
    assert.equal(R.sideStep(t.route, state, t.side).kind, 'ended', '支线走完自己的最后一段就结束');
    assert.equal(R.compose(t.route, state), '路口正文', '支线结束以后这一块不发');

    const waitCase = demoRoute(R);
    waitCase.side.wait = true;
    const waiting = R.normalizeRouteState(null, waitCase.route);
    R.sideStart(waitCase.route, waiting, waitCase.side);
    assert.equal(R.mainStep(waitCase.route, waiting).kind, 'wait', '设成等它时，主线停下来');
    assert.equal(waiting.cur, waitCase.start);

    const untilCase = demoRoute(R);
    untilCase.side.until = untilCase.fork;
    const until = R.normalizeRouteState(null, untilCase.route);
    R.sideStart(untilCase.route, until, untilCase.side);
    const step = R.mainStep(untilCase.route, until);
    assert.deepEqual(plain(step.closed.map(side => side.name)), ['夏日祭'], '主线到了那一段，支线没走完也结束');

    const skipCase = demoRoute(R);
    const skipped = R.normalizeRouteState(null, skipCase.route);
    R.mainStep(skipCase.route, skipped);
    assert.equal(R.classify(skipCase.route, skipped)[skipCase.side.root], 'dead', '主线离开那段还没开始，这条支线变灰');
    assert.equal(R.offeredSides(skipCase.route, skipped).length, 0);
});

test('路线图：主线退回去，支线回到离开那一段时的样子（被主线关掉的、走完的都回来，存档读回也一样）', () => {
    const R = load().core.routes;
    const t = demoRoute(R);
    t.side.until = t.fork;
    const state = R.normalizeRouteState(null, t.route);
    R.sideStart(t.route, state, t.side);
    R.sideStep(t.route, state, t.side);
    const sideAt = state.sides[t.side.id].cur;
    R.mainStep(t.route, state);
    assert.equal(state.sides[t.side.id].status, 'done', '主线到了那一段，支线结束');
    const saved = R.normalizeRouteState(JSON.parse(JSON.stringify(state)), t.route);
    assert.equal(R.mainBack(t.route, saved), true);
    assert.equal(saved.cur, t.start);
    assert.equal(saved.sides[t.side.id].status, 'on', '退回去，支线接着走');
    assert.equal(saved.sides[t.side.id].cur, sideAt, '停在离开时走到的那一段');

    // 支线在后面那一段才走完：退回去也回来。
    const later = demoRoute(R);
    const st = R.normalizeRouteState(null, later.route);
    R.sideStart(later.route, st, later.side);
    R.mainStep(later.route, st);
    R.sideStep(later.route, st, later.side);
    assert.equal(R.sideStep(later.route, st, later.side).kind, 'ended');
    R.mainBack(later.route, st);
    assert.equal(st.sides[later.side.id].status, 'on', '支线在后面走完的，退回挂它的那一段时回来');
    assert.equal(st.sides[later.side.id].cur, later.side.root);

    // 旧存档没记下支线的样子：主线到了某段才关掉的支线也接着走。
    const old = demoRoute(R);
    old.side.until = old.fork;
    const os = R.normalizeRouteState(null, old.route);
    R.sideStart(old.route, os, old.side);
    R.mainStep(old.route, os);
    const legacy = JSON.parse(JSON.stringify(os));
    delete legacy.histSides;
    const back = R.normalizeRouteState(legacy, old.route);
    R.mainBack(old.route, back);
    assert.equal(back.sides[old.side.id].status, 'on', '旧存档退回去，被主线关掉的支线也回来');
});

test('路线图：分块模板一直发 / 走到某几段时发，空格子整行不发', () => {
    const R = load().core.routes;
    const t = demoRoute(R);
    t.route.blocks = [
        { id: 'a', when: 'always', text: '写作风格：慢节奏。\n\n现在：\n⟦main⟧' },
        { id: 'b', when: 'nodes', nodes: [t.fork], text: '信的内容：等这个夏天结束。' },
        { id: 'c', when: 'always', text: '⟦sides⟧' },
    ];
    const state = R.normalizeRouteState(null, t.route);
    assert.equal(R.compose(t.route, state), '写作风格：慢节奏。\n\n现在：\n开场正文', '支线没开始时「其余支线」那一行整行不发');
    R.mainStep(t.route, state);
    assert.match(R.compose(t.route, state), /信的内容/, '走到选中的段才发');
    R.sideStart(t.route, state, t.side);
    assert.match(R.compose(t.route, state), /夏日祭：邀约正文/, '没单独放格子的支线进「其余正在走的支线」');
    R.mainGo(t.route, state, t.stay);
    assert.doesNotMatch(R.compose(t.route, state), /信的内容/, '离开那几段就不发');
});

test('路线图：读回时清掉断掉的线和没用的块，顺序数字算在两条中间', () => {
    const R = load().core.routes;
    const route = R.normalizeRoute({
        id: 'tabc', name: '测试', root: 'n1',
        nodes: {
            n1: { id: 'n1', name: '一', next: [{ to: 'n2' }, { to: 'gone' }, { to: 'n2' }], fallback: 3 },
            n2: { id: 'n2', name: '二', next: [] },
            n9: { id: 'n9', name: '孤儿', next: [] },
        },
        sides: [{ id: 'sx', name: '没宿主', host: 'nope', root: 'n2' }],
        blocks: [{ id: 'k1', when: 'side:sx', text: '⟦side:sx⟧' }, { id: 'k2', when: 'nodes', nodes: ['n2', 'gone'], text: 'x' }],
    });
    assert.deepEqual(plain(route.nodes.n1.next), [{ to: 'n2', cond: '' }], '指向不存在的段、重复的线都去掉');
    assert.equal(route.nodes.n1.fallback, -1);
    assert.equal(route.nodes.n9, undefined, '走不到的段去掉');
    assert.equal(route.sides.length, 0, '宿主没了的支线去掉');
    const kept = plain(route.blocks);
    assert.equal(kept.length, 2, '支线没了，它那一块也去掉');
    assert.deepEqual([kept[0].when, kept[0].text], ['always', '⟦main⟧'], '没有「一直发：主线当前段」那一块时补在最前面');
    assert.equal(kept[1].id, 'k2');
    assert.deepEqual(plain(route.blocks[1].nodes), ['n2']);
    const list = [
        { uid: 1, name: '人物', placement: { pos: 'after_character_definition', depth: 4, order: 100 } },
        { uid: 2, name: '地点', placement: { pos: 'after_character_definition', depth: 4, order: 200 } },
        { uid: 3, name: '我', isSelf: true, placement: { pos: 'after_character_definition', depth: 4, order: 999 } },
    ];
    assert.equal(R.orderAfter(list, { pos: 'after_character_definition' }, '1'), 150, '排在「人物」后面：取两条中间');
    assert.equal(R.orderAfter(list, { pos: 'after_character_definition' }, '2'), 210, '排在最后一条后面：多 10');
    assert.equal(R.orderAfter(list, { pos: 'after_character_definition' }, '__first__'), 90, '排在最前面');
    const at = order => ({ pos: 'before_character_definition', depth: 4, order });
    const tight = [
        { uid: 1, name: '元数据', placement: at(0) },
        { uid: 2, name: '运作设定', placement: at(1) },
        { uid: 3, name: '地点', placement: at(2) },
        { uid: 4, name: '人物', placement: at(10) },
    ];
    const before = { pos: 'before_character_definition' };
    assert.deepEqual(plain(R.makeRoom(tight, before, '1')), { order: 1, shifts: [{ uid: 2, order: 2 }, { uid: 3, order: 3 }] }, '顺序数字挨着：后面的往后挪，挪到有空位为止');
    assert.deepEqual(plain(R.makeRoom(tight, before, '__first__')), { order: 0, shifts: [{ uid: 1, order: 1 }, { uid: 2, order: 2 }, { uid: 3, order: 3 }] }, '最前面那条是 0：前面几条一起往后挪');
    assert.deepEqual(plain(R.makeRoom(tight, before, '3')), { order: 6, shifts: [] }, '有空位就取中间，不动别的');
    const tie = [1, 2, 3].map(uid => ({ uid, name: `同${uid}`, placement: at(100) }));
    assert.deepEqual(plain(R.makeRoom(tie, before, '1')), { order: 101, shifts: [{ uid: 2, order: 102 }, { uid: 3, order: 103 }] }, '顺序数字一样：照列出来的先后拉开');
    const ruled = R.normalizeRoute({
        ...plain(R.makeRoute('规则')),
        extractRules: [{ start: '<正文>', end: '' }, { start: ' ', end: '' }, 'x'],
        excludeRules: [{ start: '<thinking>', end: '</thinking>' }],
    });
    assert.deepEqual(plain(ruled.extractRules), [{ start: '<正文>', end: '' }], '填了一半的规则留着，空的和不是对象的丢掉');
    assert.deepEqual(plain(ruled.excludeRules), [{ start: '<thinking>', end: '</thinking>' }]);
    assert.deepEqual(plain(R.normalizeRoute(plain(R.makeRoute('没规则'))).excludeRules), [], '旧的路线图读回来没有规则');
});

function routeWorld() {
    const books = {
        书A: [
            { uid: 1, name: '人物设定', content: '人物', enabled: true, position: { type: 'after_character_definition', order: 100 }, strategy: { type: 'selective', keys: ['人物'], keys_secondary: { logic: 'and_any', keys: [] } } },
            { uid: 2, name: '地点', content: '地点', enabled: true, position: { type: 'after_character_definition', order: 200 } },
        ],
    };
    const world = multiWorld(books, {});
    world.helper.getCharData = () => ({ name: '测试角色', data: { name: '测试角色', extensions: { world: '书A' } } });
    return world;
}

test('路线图：世界书里一棵树只有一个条目，走一步换内容，位置和顺序不被盖掉', async () => {
    const world = routeWorld();
    const run = load(world.helper);
    await new Promise(setImmediate);
    const R = run.core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    t.route.placement = { pos: 'at_depth', depth: 2, role: 'system', order: 50 };
    await R.write([t.route]);
    await R.sync();
    const mine = () => world.state.books.书A.filter(item => item.name === '海边书店（动态指导）');
    assert.equal(mine().length, 1, '一棵树只建一个条目');
    assert.equal(world.state.books.书A.length, 3, '世界书里只多了这一个');
    assert.equal(mine()[0].content, '开场正文');
    assert.equal(mine()[0].enabled, true);
    assert.equal(mine()[0].strategy.type, 'constant', '一直发送，不靠关键词');
    assert.deepEqual(plain(mine()[0].strategy.keys), [], '不照抄模板条目的关键词');
    assert.deepEqual(plain(mine()[0].position), { type: 'at_depth', order: 50, depth: 2, role: 'system' }, '新建时用设好的位置');

    const state = R.normalizeRouteState(null, t.route);
    R.mainStep(t.route, state);
    await R.writeState(t.route.id, state);
    await R.sync();
    assert.equal(mine()[0].content, '路口正文', '走一步，条目内容跟着换');

    mine()[0].position = { type: 'before_character_definition', order: 7 };
    await R.sync();
    assert.deepEqual(plain(mine()[0].position), { type: 'before_character_definition', order: 7 }, '用户在世界书里改的位置不盖掉');
    const saved = (await R.read())[0];
    assert.equal(saved.placement.pos, 'before_character_definition', '读回来记下');
    assert.equal(saved.placement.order, 7);

    saved.name = '海边书店·夏';
    await R.write([saved]);
    await R.sync();
    assert.equal(mine().length, 0);
    assert.equal(world.state.books.书A.filter(item => item.name === '海边书店·夏（动态指导）').length, 1, '改名时条目跟着改名，不另建');

    await R.setPlacement(saved, { pos: 'after_character_definition', order: 150 });
    const renamed = world.state.books.书A.find(item => item.name === '海边书店·夏（动态指导）');
    assert.equal(renamed.position.type, 'after_character_definition');
    assert.equal(renamed.position.order, 150, '在助手里改位置会写进世界书');

    const finished = R.normalizeRouteState(null, saved);
    R.jumpTo(saved, finished, t.meet);
    R.mainStep(saved, finished);
    await R.writeState(saved.id, finished);
    await R.sync();
    assert.equal(renamed.enabled, false, '走到终点，条目关掉');
    assert.equal(renamed.content, '');
    assert.equal(world.state.books.书A.length, 3, '条目留着，位置和顺序还在');
    assert.deepEqual(run.errors, []);
});

test('路线图：条目名带「（动态指导）」也不会被当成旧镜像重建绑定；旧卡上存的「总开关关闭」不再认', async () => {
    const world = routeWorld();
    world.state.books.书A.push({ uid: 3, name: '海边书店', content: '## 一\n正文', enabled: true });
    const run = load(world.helper);
    await new Promise(setImmediate);
    const R = run.core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    await R.write([t.route]);
    await R.sync();
    await world.state.events.get('chat_changed')();
    await new Promise(setImmediate);
    assert.equal(world.state.variables.character.$dynamicGuideAssistant.config.bindings.length, 0, '路线图条目不能被认成「海边书店」的镜像');
    world.state.variables.character.$dynamicGuideAssistant.config.settings = { guideEnabled: false };
    await world.state.events.get('generate')('normal');
    const entry = world.state.books.书A.find(item => item.name === '海边书店（动态指导）');
    assert.equal(entry.enabled, true, '总开关没有了，旧卡上存的关闭不能让条目一直关着');
    assert.deepEqual(run.errors, []);
});

test('路线图：打开面板就是选中的那棵树，主线一行、支线一行，点下一段会走', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const R = load().core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    world.state.variables.character.$dynamicGuideAssistant.routes = { version: 1, list: [plain(t.route)] };
    world.helper.getWorldbookNames = () => ['书A'];
    const { errors, sandbox } = loadWithDocument(documentRef, world.helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    const card = panel().querySelector(`.dga-rt-card-${t.route.id}`);
    assert.ok(card, '打开面板直接是这棵树');
    assert.match(card.textContent, /海边书店/);
    assert.ok(card.querySelector('.dga-rt-svg'), '卡里画出路线图');
    assert.match(card.querySelector('.dga-rt-rows').textContent, /主线.*开场/, '主线一行写着现在在哪');
    assert.match(card.querySelector('.dga-rt-rows').textContent, /可以开始.*夏日祭/, '挂在这段的支线可以开始');
    findButton(card, '下一段').listeners.click[0]();
    for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
    const after = panel().querySelector(`.dga-rt-card-${t.route.id}`);
    assert.match(after.querySelector('.dga-rt-rows').textContent, /现在：路口/, '点下一段走到路口');
    const saved = world.state.variables.chat.$dynamicGuideAssistant.routeState.routes[t.route.id];
    assert.equal(saved.cur, t.fork, '进度存进聊天变量');
    assert.match(documentRef.getElementById('dynamic-guide-assistant-style').textContent, /\.dga-rt-drawer \{/, '带上路线图的样式');

    // 看的时候点一段：小卡片只放正文，没有按钮；编辑时点一段，侧边栏只有正文、完成条件、下一段。
    const nodeEl = findAllClass(panel(), 'dga-rt-node').find(item => item.textContent.includes('开场'));
    nodeEl.listeners.click[0]();
    const peek = panel().querySelector('.dga-rt-peek');
    assert.ok(peek, '点一段弹出小卡片');
    assert.match(peek.textContent, /开场正文/, '卡片里是这一段的正文');
    assert.doesNotMatch(peek.textContent, /完成条件|下一段|路口|支线|改这一段|从这里接着走/, '卡片里不放完成条件、下一段、支线，也没有按钮');
    findButton(panel().querySelector(`.dga-rt-card-${t.route.id}`).querySelector('.dga-rt-head'), '编辑路线').listeners.click[0]();
    findAllClass(panel(), 'dga-rt-node').find(item => item.textContent.includes('开场')).listeners.click[0]();
    const drawer = panel().querySelector('.dga-rt-drawer');
    assert.ok(drawer, '编辑时点一段打开侧边栏');
    const labels = findAllClass(drawer, 'dga-rt-nd-label').map(item => (String(item.textContent).match(/^(正文|完成条件|下一段|路口)/) || ['?'])[0]);
    assert.deepEqual(labels, ['正文', '完成条件', '下一段'], '侧边栏只有正文、完成条件、下一段');
    assert.doesNotMatch(drawer.textContent, /更多|额外发|笔记|怎么走到这里/, '不再有更多、额外发的块、笔记');
    assert.ok(!drawer.querySelector('.dga-rt-nd-go').listeners.click, '下一段那一行点了不跳');
    assert.equal(panel().querySelector('.dga-rt-peek'), null, '改的时候小卡片收起');
    assert.deepEqual(errors, []);
});

test('路线图：左栏是标志、路线图列表、API / 运行日志 / 设置', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const R = load().core.routes;
    const a = demoRoute(R);
    const b = R.makeRoute('高二上学期');
    a.route.worldbookName = '书A';
    b.worldbookName = '书A';
    world.state.variables.character.$dynamicGuideAssistant.routes = { version: 1, list: [plain(a.route), plain(b)] };
    const { errors, sandbox } = loadWithDocument(documentRef, world.helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    const rail = () => panel().querySelector('.dga-rail');
    assert.equal(rail().querySelector('.dga-rail-toggle'), null, '标志那一行不放总开关');
    assert.equal(rail().querySelector('[role="switch"]'), null);
    assert.match(rail().querySelector('.dga-rail-state').textContent, /^v\d+\.\d+\.\d+$/, '标题下面只写版本号');
    const trees = rail().querySelector('.dga-rail-trees');
    assert.equal(trees.children.length, 2, '每棵树一行');
    assert.match(trees.textContent, /海边书店开场/, '名字下面只写现在在哪一段');
    assert.doesNotMatch(trees.textContent, /条支线在走/, '不写「几条支线在走」');
    assert.equal(rail().querySelector('.dga-rail-pulse'), null, '左边不放圆点');
    assert.doesNotMatch(rail().textContent, /仪表盘|开发者模式|动态指导(?!助手)/);
    findButton(trees, '高二上学期').listeners.click[0]();
    assert.ok(panel().querySelector(`.dga-rt-card-${b.id}`), '点哪棵右边就显示哪棵');
    assert.equal(panel().querySelector(`.dga-rt-card-${a.route.id}`), null, '右边一次只放一棵');
    findButton(rail(), '设置').listeners.click[0]();
    const settingsText = panel().querySelector('.dga-body').textContent;
    assert.match(settingsText, /往下走.*AI 判断.*多久问一次.*给它看几段回复.*流式输出.*判断提示词/, '设置页：往下走、AI 判断、判断提示词');
    const titles = findAllClass(panel(), 'dga-set-title');
    const promptTitle = titles.find(node => node.textContent.includes('判断提示词'));
    const judgeDot = titles.find(node => node.textContent.includes('AI 判断')).querySelector('.dga-info-dot');
    const promptDot = promptTitle.querySelector('.dga-info-dot');
    assert.equal(promptDot.textContent, '!', '判断提示词旁边有感叹号');
    assert.equal(promptDot.className, judgeDot.className, '两个感叹号用同一套样式');
    assert.match(promptTitle.querySelector('.dga-info-pop').textContent, /酒馆账号走/);
    assert.doesNotMatch(promptTitle.parentNode.parentNode.querySelector('.dga-set-box').textContent, /酒馆账号走/, '说明不再铺在卡片里');
    assert.doesNotMatch(settingsText, /大检查|推进冷却|开发者模式|外观|配色/, '用不上的设置都去掉了');
    assert.match(settingsText, /在最上面加一段.*在最下面加一段/, '提示词段最上面和最下面都能加一段');
    findButton(rail(), 'API').listeners.click[0]();
    assert.match(panel().querySelector('.dga-head').textContent, /API/);
    assert.match(panel().querySelector('.dga-body').textContent, /预设名称.*连接方式.*酒馆主 API.*自定义/, 'API 页：预设名称、连接方式');
    assert.deepEqual(errors, []);
});

test('路线图：卡片标题栏是编辑路线 / 位置和顺序 / 发给 AI 的内容 / 设置，往下走在设置里', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const R = load().core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    world.state.variables.character.$dynamicGuideAssistant.routes = { version: 1, list: [plain(t.route)] };
    const { errors, sandbox } = loadWithDocument(documentRef, world.helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    const card = () => panel().querySelector(`.dga-rt-card-${t.route.id}`);
    const head = card().querySelector('.dga-rt-head');
    assert.match(head.textContent, /编辑路线.*位置和顺序.*发给 AI 的内容.*设置/);
    assert.doesNotMatch(card().textContent, /往下走|现在检查|上次（第/, '卡片上没有往下走那一行');
    assert.match(card().querySelector('.dga-rt-rows').textContent, /可以开始支线 · 夏日祭进入条件/, '进入条件写在支线名后面');
    assert.ok(card().querySelector('.dga-rt-zoomf'), '缩放在图的右下角');
    findButton(head, '设置').listeners.click[0]();
    const drawer = () => panel().querySelector('.dga-rt-drawer');
    assert.match(drawer().textContent, /往下走.*删掉这张路线图/);
    assert.doesNotMatch(drawer().textContent, /判断用的 API/, '没选 AI 判断时不出现 AI 判断那一组');
    assert.ok(!drawer().classList.contains('is-shown'), '刚打开时播一次滑入');
    findButton(drawer(), 'AI 判断').listeners.click[0]();
    assert.ok(drawer().classList.contains('is-shown'), '开着时点按钮重画，不再播滑入（不闪）');
    assert.match(drawer().textContent, /判断用的 API.*跟随当前活动API.*判断提示词/, '选了 AI 判断才出现');
    assert.match(drawer().textContent, /判断提示词.*提取 \/ 排除规则.*删掉这张路线图/, '提取 / 排除规则在 AI 判断下面、删除上面');
    assert.equal(findAllClass(drawer(), 'dga-rs-rule').length, 0, '没有规则时不列空行');
    findButton(drawer(), '＋ 加一条').listeners.click[0]();
    assert.equal(findAllClass(drawer(), 'dga-rs-rule').length, 1, '点「加一条」多一行开始 / 结束');
    assert.doesNotMatch(drawer().textContent, /›/, '判断提示词右边不放跳转箭头');
    findButton(card().querySelector('.dga-rt-head'), '发给 AI 的内容').listeners.click[0]();
    const first = () => findAllClass(drawer(), 'dga-rt-blk')[0];
    assert.match(first().textContent, /一直发/);
    assert.ok(!findAllClass(first(), 'dga-rt-icon').some(node => node.getAttribute('title') === '删掉这一块'), '发主线当前段的那一块没有删除');
    first().querySelector('.dga-rt-blk-row').listeners.click[0]();
    const seg = first().querySelector('.dga-rt-seg');
    assert.equal(findButton(seg, '走到某几段时').getAttribute('disabled'), '', '也改不成别的发法');
    findButton(card().querySelector('.dga-rt-head'), '编辑路线').listeners.click[0]();
    assert.match(card().querySelector('.dga-rt-head').textContent, /完成编辑/);
    assert.deepEqual(errors, []);
});

test('路线图：编辑时能「放弃修改」，名字和发的内容都回到点编辑之前的样子', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const R = load().core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    world.state.variables.character.$dynamicGuideAssistant.routes = { version: 1, list: [plain(t.route)] };
    const { errors, sandbox } = loadWithDocument(documentRef, world.helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    const head = () => panel().querySelector(`.dga-rt-card-${t.route.id}`).querySelector('.dga-rt-head');
    const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(setImmediate); };
    const saved = () => world.state.variables.character.$dynamicGuideAssistant.routes.list[0];
    assert.doesNotMatch(head().textContent, /放弃修改/, '不在编辑时没有这个按钮');
    findButton(head(), '编辑路线').listeners.click[0]();
    assert.match(head().textContent, /放弃修改.*完成编辑/);
    findButton(head(), '放弃修改').listeners.click[0]();
    assert.ok(!panel().querySelector('.dga-rt-modal'), '什么都没改就直接退出编辑，不问');
    assert.match(head().textContent, /编辑路线/);
    findButton(head(), '编辑路线').listeners.click[0]();
    head().querySelector('.dga-rt-name-input').listeners.change[0]({ target: { value: '改过的名字' } });
    await settle();
    assert.equal(saved().name, '改过的名字');
    assert.ok(world.state.books.书A.some(item => item.name === '改过的名字（动态指导）'));
    findButton(head(), '放弃修改').listeners.click[0]();
    const modal = panel().querySelector('.dga-rt-modal');
    assert.match(modal.textContent, /放弃这次的修改/);
    findButton(modal, '放弃修改').listeners.click[0]();
    await settle();
    assert.equal(saved().name, '海边书店', '角色变量里回到原来的名字');
    assert.ok(world.state.books.书A.some(item => item.name === '海边书店（动态指导）'), '世界书条目也改回来');
    assert.equal(world.state.books.书A.filter(item => /（动态指导）$/.test(item.name)).length, 1, '没有多建条目');
    assert.match(head().textContent, /编辑路线/, '退出了编辑');
    assert.deepEqual(errors, []);
});

test('路线图：位置和顺序不列数据库和 MVU 的条目；放到顺序数字一样的两条中间，后面的往后挪', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const after = order => ({ type: 'after_character_definition', order });
    world.state.books.书A.push(
        { uid: 3, name: 'TavernDB-ACU-ReadableDataTable', content: '表', enabled: true, position: after(150) },
        { uid: 4, name: '[InitVar]初始化变量', content: '{}', enabled: false, position: after(150) },
        { uid: 5, name: '天气', content: '晴', enabled: true, position: after(200) },
        { uid: 6, name: '时间', content: '夏', enabled: true, position: after(201) },
    );
    const R = load().core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    t.route.placement = { ...t.route.placement, pos: 'before_character_definition' };
    world.state.variables.character.$dynamicGuideAssistant.routes = { version: 1, list: [plain(t.route)] };
    const { errors, sandbox } = loadWithDocument(documentRef, world.helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    findButton(panel().querySelector(`.dga-rt-card-${t.route.id}`).querySelector('.dga-rt-head'), '位置和顺序').listeners.click[0]();
    for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
    const drawer = panel().querySelector('.dga-rt-drawer');
    assert.doesNotMatch(drawer.textContent, /TavernDB|InitVar/, '数据库和 MVU 的条目不列');
    const group = findAllClass(drawer, 'dga-rt-order-group').find(node => /角色定义后/.test(node.textContent));
    assert.match(group.textContent, /人物设定.*地点.*天气.*时间/);
    const slots = findAllClass(group, 'dga-rt-slot');
    assert.equal(slots.length, 5, '每两条中间都能放');
    slots[2].listeners.click[0]();
    for (let i = 0; i < 8; i += 1) await new Promise(setImmediate);
    const order = name => {
        const entry = world.state.books.书A.find(item => item.name === name);
        return entry.position.order;
    };
    assert.equal(order('地点'), 200, '前面的不动');
    assert.equal(order('天气'), 202, '和「地点」一样是 200 的「天气」往后挪');
    assert.equal(order('时间'), 203, '后面挨着的也跟着挪，先后不变');
    assert.equal(order('TavernDB-ACU-ReadableDataTable'), 150, '数据库条目不碰');
    assert.deepEqual(errors, []);
});

test('路线图：一直发里至少留一块主线当前段——有两块时都能删，剩最后一块才拦住', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const R = load().core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    t.route.blocks = [
        { id: 'ka', when: 'always', text: '开头 ⟦main⟧' },
        { id: 'kb', when: 'always', text: '只是一句提醒' },
        { id: 'kc', when: 'always', text: '⟦main⟧ 结尾' },
    ];
    world.state.variables.character.$dynamicGuideAssistant.routes = { version: 1, list: [plain(t.route)] };
    const { errors, sandbox } = loadWithDocument(documentRef, world.helper);
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await sandbox.DynamicGuideAssistantCore.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    findButton(panel().querySelector(`.dga-rt-card-${t.route.id}`).querySelector('.dga-rt-head'), '发给 AI 的内容').listeners.click[0]();
    const blocks = () => findAllClass(panel().querySelector('.dga-rt-drawer'), 'dga-rt-blk');
    const deleteBtn = node => findAllClass(node, 'dga-rt-icon').find(item => item.getAttribute('title') === '删掉这一块');
    assert.equal(blocks().length, 3);
    assert.ok(blocks().every(node => deleteBtn(node)), '两块都放着主线当前段时，哪块都能删；不放的一直发也能删');
    deleteBtn(blocks()[0]).listeners.click[0]({ stopPropagation() {} });
    assert.equal(blocks().length, 2);
    assert.ok(deleteBtn(blocks()[0]), '不放主线的那块照样能删');
    assert.ok(!deleteBtn(blocks()[1]), '剩最后一块放着主线当前段的，不能删');
    assert.deepEqual(errors, []);
});

function memoryStorage(initial) {
    const data = new Map(Object.entries(initial || {}));
    return {
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key),
        get length() { return data.size; },
        key: index => Array.from(data.keys())[index] || null,
    };
}

const API_PRESETS_KEY = 'dynamic-guide-assistant:judge-api-presets:v1';
const API_OVERRIDES_KEY = 'dynamic-guide-assistant:preset-overrides:v1';
const API_SETTINGS_KEY = 'dynamic-guide-assistant';
const sampleApiPreset = name => ({ name, connection: 'custom', apiurl: 'https://example.com/v1', key: 'test-secret-only', model: 'test-model' });

test('API 存储：旧预设和路线图选择一起迁移，保留原始备份及布局，不向角色/聊天泄露密钥', async () => {
    const world = routeWorld();
    const host = settingsHost({ [API_SETTINGS_KEY]: { layouts: { kept: true } }, otherExtension: { kept: true } });
    const presets = JSON.stringify([sampleApiPreset('旧预设')]);
    const overrides = JSON.stringify({ chats: { oldChat: '旧预设' }, lines: { 'route:r1': '旧预设' } });
    const storage = memoryStorage({ [API_PRESETS_KEY]: presets, [API_OVERRIDES_KEY]: overrides });
    const run = load(world.helper, { SillyTavern: host.SillyTavern, localStorage: storage });
    await new Promise(setImmediate);
    const stored = host.state.persisted[API_SETTINGS_KEY];
    assert.equal(stored.apiStore.presets[0].key, 'test-secret-only');
    assert.equal(stored.apiStore.overrides.lines['route:r1'], '旧预设');
    assert.equal(stored.apiStore.overrides.chats.oldChat, '旧预设');
    assert.deepEqual(stored.layouts, { kept: true });
    assert.deepEqual(host.state.persisted.otherExtension, { kept: true });
    assert.equal(host.state.saves, 1);
    assert.equal(await run.core.apiStorage.migrate(), false);
    assert.equal(host.state.saves, 1, '重复迁移不能重复保存');
    assert.equal(storage.getItem(API_PRESETS_KEY), presets);
    assert.equal(storage.getItem(API_OVERRIDES_KEY), overrides);
    assert.doesNotMatch(JSON.stringify(world.state.variables), /test-secret-only|test-model|example.com/);
    assert.doesNotMatch(JSON.stringify(run.core.log.list()), /test-secret-only/);
});

test('API 存储：另一浏览器不需要 localStorage；已有空配置也不被旧备份复活', async () => {
    const firstHost = settingsHost();
    const first = load(null, { SillyTavern: firstHost.SillyTavern }).core;
    await first.apiStorage.writePresets([sampleApiPreset('共享')]);
    await first.routes.setApi({ id: 'r1' }, '共享');
    const secondHost = settingsHost(plain(firstHost.state.persisted));
    const second = load(null, { SillyTavern: secondHost.SillyTavern, localStorage: memoryStorage() }).core;
    assert.equal(second.apiStorage.read().presets[0].key, 'test-secret-only');
    assert.equal(second.routes.apiName({ id: 'r1' }), '共享');
    await second.apiStorage.writePresets([], '共享', '');
    const stale = memoryStorage({ [API_PRESETS_KEY]: JSON.stringify([sampleApiPreset('共享')]), [API_OVERRIDES_KEY]: JSON.stringify({ lines: { 'route:r1': '共享' } }) });
    const thirdHost = settingsHost(plain(secondHost.state.persisted));
    const third = load(null, { SillyTavern: thirdHost.SillyTavern, localStorage: stale }).core;
    assert.equal(await third.apiStorage.migrate(), false);
    assert.deepEqual(plain(third.apiStorage.read().presets), []);
    assert.equal(third.routes.apiName({ id: 'r1' }), '');
    assert.equal(thirdHost.state.saves, 0);
});

test('API 存储：新浏览器无旧数据时不抢先建立空配置', async () => {
    const host = settingsHost();
    const run = load(null, { SillyTavern: host.SillyTavern }).core;
    assert.deepEqual(plain(run.apiStorage.read().presets), []);
    assert.equal(await run.apiStorage.migrate(), false);
    assert.deepEqual(host.state.settings, {});
    assert.equal(host.state.saves, 0);
});

test('API 存储：宿主未就绪/无保存接口时拒绝写入，稍后可重试迁移', async () => {
    const host = settingsHost();
    let ready = false;
    const localStorage = memoryStorage({ [API_PRESETS_KEY]: JSON.stringify([sampleApiPreset('旧')]) });
    const run = load(null, { SillyTavern: { getContext: () => ready ? host.context : null }, localStorage }).core;
    await assert.rejects(run.apiStorage.migrate(), /尚未就绪/);
    assert.deepEqual(host.state.settings, {});
    ready = true;
    const save = host.context.saveSettingsDebounced;
    delete host.context.saveSettingsDebounced;
    await assert.rejects(run.apiStorage.migrate(), /接口不可用/);
    assert.deepEqual(host.state.settings, {});
    host.context.saveSettingsDebounced = save;
    assert.equal(await run.apiStorage.migrate(), true);
    assert.equal(run.apiStorage.read().presets[0].name, '旧');
});

test('API 存储：同步异常、异步拒绝和失败返回均回滚，队列仍可重试', async () => {
    for (const fail of [() => { throw new Error('test-secret-only'); }, async () => { throw new Error('test-secret-only'); }, () => false, () => ({ ok: false })]) {
        const host = settingsHost();
        const run = load(null, { SillyTavern: host.SillyTavern }).core;
        await run.apiStorage.writePresets([sampleApiPreset('原名')]);
        await run.routes.setApi({ id: 'r1' }, '原名');
        const before = plain(host.state.settings);
        const save = host.context.saveSettingsDebounced;
        host.context.saveSettingsDebounced = fail;
        await assert.rejects(run.apiStorage.writePresets([sampleApiPreset('新名')], '原名', '新名'), /已回滚/);
        assert.deepEqual(plain(host.state.settings), before, '预设及引用一起回滚');
        assert.doesNotMatch(run.apiStorage.notice(), /test-secret-only/);
        host.context.saveSettingsDebounced = save;
        await run.apiStorage.writePresets([sampleApiPreset('新名')], '原名', '新名');
        assert.equal(run.routes.apiName({ id: 'r1' }), '新名');
        await run.apiStorage.writePresets([], '新名', '');
        assert.equal(run.routes.apiName({ id: 'r1' }), '');
    }
});

test('API 存储：迁移失败保留旧备份和布局，坏 JSON/未知版本不覆盖', async () => {
    const raw = JSON.stringify([sampleApiPreset('旧')]);
    const storage = memoryStorage({ [API_PRESETS_KEY]: raw });
    const host = settingsHost({ [API_SETTINGS_KEY]: { layouts: { keep: true } } });
    host.context.saveSettingsDebounced = async () => { throw new Error(); };
    const run = load(null, { SillyTavern: host.SillyTavern, localStorage: storage }).core;
    await assert.rejects(run.apiStorage.migrate(), /已回滚/);
    assert.deepEqual(host.state.settings, { [API_SETTINGS_KEY]: { layouts: { keep: true } } });
    assert.equal(storage.getItem(API_PRESETS_KEY), raw);
    storage.setItem(API_PRESETS_KEY, 'test-secret-only{');
    await assert.rejects(run.apiStorage.migrate(), error => /读取失败/.test(error.message) && !error.message.includes('test-secret-only'));
    const unknown = { version: 2, presets: [], overrides: {} };
    host.state.settings[API_SETTINGS_KEY].apiStore = unknown;
    await assert.rejects(run.apiStorage.migrate(), /版本不兼容/);
    assert.equal(host.state.settings[API_SETTINGS_KEY].apiStore, unknown);
});

test('API 存储：串行等待异步保存，失败后不阻塞后续路线图选择', async () => {
    const host = settingsHost();
    const run = load(null, { SillyTavern: host.SillyTavern }).core;
    await run.apiStorage.writePresets([sampleApiPreset('甲')]);
    let rejectSave;
    host.context.saveSettingsDebounced = () => new Promise((resolve, reject) => { rejectSave = reject; });
    const first = run.routes.setApi({ id: 'r1' }, '甲');
    const failed = assert.rejects(first, /已回滚/);
    await new Promise(setImmediate);
    const second = run.routes.setApi({ id: 'r2' }, '甲');
    host.context.saveSettingsDebounced = () => { host.state.persisted = plain(host.state.settings); };
    rejectSave(new Error());
    await failed;
    await second;
    assert.equal(run.routes.apiName({ id: 'r1' }), '');
    assert.equal(run.routes.apiName({ id: 'r2' }), '甲');
    assert.equal(host.state.persisted[API_SETTINGS_KEY].apiStore.overrides.lines['route:r2'], '甲');
});

test('路线图：判断提示词按段发，格子换成当时的内容；关掉的段不发，没放作答表自动补上', () => {
    const R = load().core.routes;
    const t = demoRoute(R);
    const state = R.normalizeRouteState(null, t.route);
    R.mainStep(t.route, state);
    const item = R.judgeCase(t.route, state);
    const host = { char: '书店老板', persona: '打工的学生', substitute: text => text.replace(/\{\{user\}\}/g, '小林') };
    const messages = plain(R.judgeMessages(t.route, item, '两人在整理旧书。', R.defaultPrompt(), host));
    assert.equal(messages.length, 7, '默认提示词 7 段');
    assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'assistant', 'system', 'system', 'assistant', 'user'], '最后一段是 USER');
    const all = messages.map(m => m.content).join('\n');
    assert.match(all, /路线图：海边书店/);
    assert.match(all, /现在这一段：路口[\s\S]*1\. 留下：小林留下[\s\S]*2\. 离开：小林离开/, '在走的线写出路口的几条路，酒馆宏换成名字');
    assert.match(all, /两人在整理旧书。/);
    assert.match(all, /<answer n="1">[\s\S]*<road>/, '作答表在路口要问走哪条');
    assert.doesNotMatch(all, /\{\{(路线图|在走的线|可以开始的支线|最近正文|作答表)\}\}/, '格子都换掉了');

    const custom = [
        { role: 'system', content: '角色：{{角色设定}}；用户：{{用户设定}}' },
        { role: 'system', content: '这一段不发', enabled: false },
        { role: 'user', content: '正文：{{最近正文}}' },
    ];
    const sent = plain(R.judgeMessages(t.route, item, '正文 $& 原样', custom, host));
    assert.equal(sent.length, 2, '关掉的段不发');
    assert.equal(sent[0].content, '角色：书店老板；用户：打工的学生');
    assert.match(sent[1].content, /^正文：正文 \$& 原样/, '正文里的 $& 按字面放');
    assert.match(sent[1].content, /## 作答表\n每条线一个 <answer>/, '没放作答表，补在最后一段 USER 末尾');
});

test('路线图：内置默认不被覆盖，通用判断提示词从用户库读取', async () => {
    const run = load().core;
    assert.deepEqual(plain(run.routes.promptPresets().map(item => item.name)), ['默认']);
    const id = await run.promptStorage.save({ name: '简短', segments: [{ role: 'SYSTEM', content: '{{作答表}}' }] });
    const list = run.routes.promptPresets();
    assert.deepEqual(plain(list.map(item => item.name)), ['默认', '简短']);
    assert.equal(list[1].id, id);
    assert.equal(list[1].segments[0].role, 'system');
    await assert.rejects(run.promptStorage.save({ name: '空的', segments: [] }), /至少一段/);
});

test('路线图：AI 判断按这张图自己选的 API 和提示词发，结论落到进度上', async () => {
    const world = routeWorld();
    world.state.messages = [{ message_id: 4, role: 'assistant', message: '<thinking>先想想怎么写</thinking>小林决定离开小镇，提着箱子去了码头。' }];
    world.state.lastMessageId = 4;
    const storage = memoryStorage({
        'dynamic-guide-assistant:judge-api-presets:v1': JSON.stringify([{ name: '便宜的', connection: 'custom', customApiFormat: 'openai_compat', apiurl: 'https://api.example.com/v1', key: 'k', model: 'm-small' }]),
    });
    const fetches = [];
    const fetchMock = async (url, options) => {
        fetches.push({ url, body: JSON.parse(options.body) });
        const content = '<thinking>草稿</thinking><judge_plan>对上了</judge_plan><answer n="1"><basis>写了离开</basis><done>YES</done><road>2</road></answer><start>0</start>';
        const text = JSON.stringify({ choices: [{ message: { content } }] });
        return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    };
    const run = load(world.helper, { localStorage: storage, fetch: fetchMock });
    await new Promise(setImmediate);
    const R = run.core.routes;
    const t = demoRoute(R);
    t.route.worldbookName = '书A';
    t.route.advance = 'judge';
    t.route.promptId = await run.core.promptStorage.save({ name: '简短', segments: [{ role: 'system', content: '只看正文' }, { role: 'user', content: '{{最近正文}}\n{{作答表}}' }] });
    t.route.excludeRules = [{ start: '<thinking>', end: '</thinking>' }];
    world.state.variables.character.$dynamicGuideAssistant.config.settings = {

        // 旧版设置里的全局规则不再用：要是还用，下面「小林决定离开小镇」会被删掉。
        excludeRules: [{ start: '小林', end: '码头' }],
    };
    await R.write([t.route]);
    const state = R.normalizeRouteState(null, t.route);
    R.mainStep(t.route, state);
    await R.writeState(t.route.id, state);
    await R.setApi(t.route, '便宜的');
    assert.equal(R.apiName(t.route), '便宜的', '这张图选的 API 存在酒馆用户设置');
    const moved = await R.judge(t.route, 4);
    assert.equal(moved, true);
    assert.equal(fetches.length, 1, '走自定义 API');
    assert.equal(fetches[0].body.model, 'm-small');
    assert.equal(fetches[0].body.messages[0].content, '只看正文', '用这张图选的那套提示词');
    assert.match(fetches[0].body.messages[1].content, /小林决定离开小镇/);
    assert.doesNotMatch(fetches[0].body.messages[1].content, /先想想/, '这张图的排除规则作用在发出去的正文上');
    assert.doesNotMatch(run.core.getJudgeRuntime().lastFiltered, /草稿/, '也作用在判断 AI 的回答上');
    const saved = (await R.readStates())[t.route.id];
    assert.equal(saved.cur, t.leave, '路口按 <road>2</road> 走了「离开」');
    assert.deepEqual(run.errors, []);
});

test('自定义 API 请求体：带 top_p，TauriTavern 带 custom_api_format，流式时合并 stream_options', () => {
    const preset = { name: 'c', connection: 'custom', customApiFormat: 'claude_messages', apiurl: 'https://api.anthropic.com', key: 'sk', model: 'claude', maxTokens: 100, temperature: 0.5, bodyParams: '{"top_k":50}' };
    const plainBody = core.buildJudgeCustomRequestBody([{ role: 'user', content: 'q' }], preset, false);
    assert.equal(plainBody.top_p, 0.95);
    assert.equal(plainBody.chat_completion_source, 'claude', '原版酒馆：Claude 走原生协议源');
    assert.equal('custom_api_format' in plainBody, false);
    assert.equal(plainBody.custom_include_body, '{"top_k":50}', '不流式时用户写的原样交给酒馆');
    const streamBody = core.buildJudgeCustomRequestBody([{ role: 'user', content: 'q' }], preset, true);
    assert.deepEqual(JSON.parse(streamBody.custom_include_body), { top_k: 50, stream_options: { include_usage: true } }, '流式时加上 include_usage');
    const yamlBody = core.buildJudgeCustomRequestBody([{ role: 'user', content: 'q' }], { ...preset, bodyParams: 'top_k: 50' }, true);
    assert.equal(yamlBody.custom_include_body, 'top_k: 50', '用户写的 YAML 不改');
    const tauri = load(null, { __TAURITAVERN__: {} });
    const tauriBody = tauri.core.buildJudgeCustomRequestBody([{ role: 'user', content: 'q' }], preset, false);
    assert.equal(tauriBody.chat_completion_source, 'custom', 'TauriTavern 下一律 custom');
    assert.equal(tauriBody.custom_api_format, 'claude_messages');
});

test('路线图：旧版绑定不再支持，启动时停用——原条目重新打开、旧镜像删掉、绑定清空', async () => {
    const world = routeWorld();
    world.state.books.书A.push(
        { uid: 5, name: '旧大纲', content: '## 一\n正文', enabled: false },
        { uid: 6, name: '旧大纲（动态指导）', content: '一', enabled: true },
    );
    world.state.variables.character.$dynamicGuideAssistant.config = {
        version: 2,
        bindings: [{ worldbookName: '书A', entryUid: 5, entryName: '旧大纲' }],
    };
    const run = load(world.helper);
    for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
    assert.equal(world.state.variables.character.$dynamicGuideAssistant.config.bindings.length, 0, '绑定清空');
    assert.equal(world.state.books.书A.find(item => item.uid === 5).enabled, true, '原条目重新打开');
    assert.equal(world.state.books.书A.some(item => item.name === '旧大纲（动态指导）'), false, '旧镜像删掉');
    assert.equal(world.state.books.书A.find(item => item.uid === 5).content, '## 一\n正文', '正文一个字不动');
    assert.deepEqual(run.errors, []);
});

const LEGACY_CONFIG_KEY = 'dynamic-guide-assistant:config:v2:name:测试角色';
const LEGACY_MODE_KEY = 'dynamic-guide-assistant:config-storage:v1';
const LEGACY_NAMES_KEY = 'dynamic-guide-assistant:preset-names:v1:name:测试角色';
const characterRoot = world => world.state.variables.character.$dynamicGuideAssistant;
const legacyConfig = settings => ({ version: 2, bindings: [], settings });

async function storageWorld(extra = {}, beforeLoad = () => {}) {
    const world = routeWorld();
    beforeLoad(world);
    const run = load(world.helper, extra);
    await new Promise(setImmediate);
    return { world, run, store: run.core.configStorage };
}

test('配置存储：旧本机配置只迁移一次，空配置权威，另一浏览器读取角色正本', async () => {
    const raw = JSON.stringify(legacyConfig({ judgeInterval: 7, storageMode: 'user', judgePreset: '旧名' }));
    const storage = memoryStorage({ [LEGACY_CONFIG_KEY]: raw });
    storage.setItem = () => { throw new Error('禁止写浏览器'); };
    const { world, store } = await storageWorld({ localStorage: storage }, world => { delete characterRoot(world).config; });
    assert.equal((await store.read()).settings.judgeInterval, 7);
    assert.equal(characterRoot(world).config.storageVersion, 1);
    assert.equal(storage.getItem(LEGACY_CONFIG_KEY), raw);
    const second = load(world.helper, { localStorage: memoryStorage() }).core;
    await new Promise(setImmediate);
    assert.equal((await second.configStorage.read()).settings.judgeInterval, 7);
    await second.configStorage.write(legacyConfig({}));
    const third = load(world.helper, { localStorage: storage }).core;
    await new Promise(setImmediate);
    assert.equal((await third.configStorage.read()).settings.judgeInterval, undefined);
    assert.equal((await third.configStorage.read()).settings.judgePreset, undefined);
});

test('配置存储：无旧数据不抢建空配置；坏 JSON 和未知版本不覆盖、不泄露原文', async () => {
    const storage = memoryStorage();
    const { world, store } = await storageWorld({ localStorage: storage }, world => { delete characterRoot(world).config; });
    await store.read();
    assert.equal(characterRoot(world).config, undefined);
    storage.setItem(LEGACY_CONFIG_KEY, 'secret-test{');
    await assert.rejects(store.read(), error => /旧配置损坏/.test(error.message) && !error.message.includes('secret-test'));
    assert.equal(characterRoot(world).config, undefined);
    characterRoot(world).config = { version: 99, bindings: [] };
    const before = plain(characterRoot(world));
    await assert.rejects(store.read(), /版本不兼容/);
    await assert.rejects(store.write(legacyConfig({})), /版本不兼容/);
    assert.deepEqual(plain(characterRoot(world)), before);
});


test('配置存储：旧模式仅决定迁移来源，世界书配置和状态保持原样，不再双写布局', async () => {
    for (const mode of ['card', 'user']) {
        const raw = JSON.stringify(legacyConfig({ judgeInterval: 8 }));
        const storage = memoryStorage({ [LEGACY_CONFIG_KEY]: raw, [LEGACY_MODE_KEY]: mode });
        const host = settingsHost({ [API_SETTINGS_KEY]: { layouts: { backup: true } } });
        const entry = { uid: 99, name: '（动态指导·配置）', enabled: false, content: JSON.stringify(legacyConfig({ judgeInterval: 4 })) };
        const stateEntry = { uid: 100, name: '（动态指导·状态）', enabled: false, content: '旧状态备份' };
        const { world, store } = await storageWorld({ localStorage: storage, SillyTavern: host.SillyTavern }, world => {
            delete characterRoot(world).config;
            world.state.books.书A.push(plain(entry), plain(stateEntry));
        });
        assert.equal((await store.read()).settings.judgeInterval, mode === 'card' ? 4 : 8);
        await store.write(legacyConfig({ judgeInterval: 2, storageMode: 'card' }));
        assert.deepEqual(world.state.books.书A.find(item => item.uid === 99), entry);
        assert.deepEqual(world.state.books.书A.find(item => item.uid === 100), stateEntry);
        assert.deepEqual(host.state.settings, { [API_SETTINGS_KEY]: { layouts: { backup: true } } });
        assert.equal(host.state.saves, 0);
        assert.equal(storage.getItem(LEGACY_CONFIG_KEY), raw);
    }
});

test('配置存储：同步/异步失败和明确拒绝不污染原对象，失败后可重试', async () => {
    const { world, store } = await storageWorld();
    const update = world.helper.updateVariablesWith;
    for (const failure of ['throw', 'reject', 'false']) {
        const before = plain(world.state.variables.character);
        world.helper.updateVariablesWith = (updater, { type }) => {
            updater(world.state.variables[type]);
            if (failure === 'throw') throw new Error('拒绝');
            if (failure === 'reject') return Promise.reject(new Error('拒绝'));
            return false;
        };
        await assert.rejects(store.write(legacyConfig({ judgeInterval: 9 })));
        assert.deepEqual(plain(world.state.variables.character), before);
    }
    world.helper.updateVariablesWith = update;
    await store.write(legacyConfig({ judgeInterval: 3 }));
    assert.equal((await store.read()).settings.judgeInterval, 3);
});


test('配置存储：切角色后拒绝旧配置写入，不把异步迁移结果写进新角色', async () => {
    const { world, store } = await storageWorld();
    const previous = await store.read();
    previous.settings.judgeInterval = 20;
    world.helper.getCharData = () => ({ name: '另一个角色' });
    world.state.variables.character = { $dynamicGuideAssistant: { config: legacyConfig({ judgeInterval: 2 }) } };
    await world.state.events.get('chat_changed')();
    await assert.rejects(store.write(previous), /切换了角色或聊天/);
    assert.equal((await store.read()).settings.judgeInterval, 2);

    delete characterRoot(world).config;
    world.helper.getCharData = () => ({ name: '测试角色', data: { extensions: { world: '书A' } } });
    let resume;
    world.helper.getWorldbook = () => new Promise(resolve => { resume = resolve; });
    const pending = store.read();
    const rejected = assert.rejects(pending, /切换了角色或聊天/);
    await new Promise(setImmediate);
    world.helper.getCharData = () => ({ name: '新角色' });
    world.state.variables.character = { $dynamicGuideAssistant: { config: legacyConfig({ judgeInterval: 5 }) } };
    resume([{ name: '（动态指导·配置）', content: JSON.stringify(legacyConfig({ judgeInterval: 99 })) }]);
    await rejected;
    assert.equal(characterRoot(world).config.settings.judgeInterval, 5);
});

test('配置存储：有效设置和提示词保留；退役字段、API 凭据不进入角色/世界书', async () => {
    const rawNames = JSON.stringify({ judgePreset: '原名', conditionPreset: '原名' });
    const storage = memoryStorage({ [LEGACY_NAMES_KEY]: rawNames });
    const { world, run, store } = await storageWorld({ localStorage: storage });
    await store.write(legacyConfig({
        autoAdvance: 'judge', judgeInterval: 3, judgeHistoryCount: 4, streamingEnabled: true,
        storageMode: 'card', judgePreset: '原名', conditionPreset: '原名',
        key: 'secret-test', apiurl: 'https://secret.invalid', judgeApiPresets: [sampleApiPreset('原名')],
    }));
    const promptId = await run.core.promptStorage.save({ name: '我的提示词', key: 'secret-test', segments: [{ role: 'system', content: '保留正文', enabled: true }] });
    const saved = await store.read();
    assert.equal(run.core.promptStorage.resolve({ promptId }).segments[0].content, '保留正文');
    assert.equal(saved.settings.routePromptPresets, undefined);
    assert.equal(saved.settings.autoAdvance, 'judge');
    assert.equal(saved.settings.streamingEnabled, true);
    assert.doesNotMatch(JSON.stringify(world.state.variables), /secret-test|secret.invalid|test-secret-only|judgePreset|storageMode/);
    const route = run.core.routes.makeRoute('安全路线');
    route.key = 'secret-test';
    route.api = sampleApiPreset('原名');
    await run.core.routes.write([route]);
    assert.doesNotMatch(JSON.stringify(world.state.variables), /secret-test|test-secret-only/);
    await run.core.apiStorage.writePresets([sampleApiPreset('原名')]);
    await run.core.updatePresetReferences('原名', '新名');
    assert.equal(storage.getItem(LEGACY_NAMES_KEY), rawNames, '退役引用备份不再更新');
    assert.equal(world.state.books.书A.length, 2, '普通配置保存不新增世界书配置/状态条目');
    assert.doesNotMatch(source, /storage\.(?:setItem|removeItem)\s*\(/);
});

const promptPreset = (name, content = name) => ({ name, segments: [{ role: 'system', content }] });

function seedLegacyPrompts(world, presets, selections = ['']) {
    const root = characterRoot(world);
    root.config = { ...legacyConfig({ routePromptPresets: presets }), storageVersion: 1 };
    root.routes = { version: 1, list: selections.map((prompt, index) => ({
        ...core.routes.makeRoute(`旧路线${index}`), id: `tlegacy${index}`, prompt,
    })) };
}

test('提示词分层：跨角色/跨浏览器共享用户库，改名不改 ID，副本可随卡独立使用', async () => {
    const host = settingsHost();
    const first = await storageWorld({ SillyTavern: host.SillyTavern });
    const P = first.run.core.promptStorage;
    const id = await P.save(promptPreset('剧情推进', '慢节奏推进'));
    const route = first.run.core.routes.makeRoute('A');
    route.promptId = id;
    await first.run.core.routes.write([route]);
    assert.equal(characterRoot(first.world).config.settings.routePromptPresets, undefined);
    assert.doesNotMatch(JSON.stringify(first.world.state.variables), /慢节奏推进/);
    const copy = P.copy(route);
    const second = await storageWorld({ SillyTavern: host.SillyTavern });
    assert.equal(second.run.core.promptStorage.resolve({ promptId: id }).segments[0].content, '慢节奏推进');
    await P.save({ ...promptPreset('推进改名', '新规则'), id });
    assert.equal(second.run.core.promptStorage.resolve({ promptId: id }).name, '推进改名');
    assert.equal(copy.segments[0].content, '慢节奏推进');
    const otherBrowser = load(null, { SillyTavern: settingsHost(plain(host.state.persisted)).SillyTavern }).core;
    assert.equal(otherBrowser.promptStorage.resolve({ promptId: id }).segments[0].content, '新规则');
    await P.remove(id);
    assert.throws(() => P.resolve(route), /找不到了/);
    route.promptLocal = copy;
    delete route.promptId;
    await first.run.core.routes.write([route]);
    const cardRoute = plain(characterRoot(first.world).routes.list[0]);
    const receiver = load(null, { SillyTavern: null }).core;
    assert.equal(receiver.promptStorage.resolve(cardRoute).segments[0].content, '慢节奏推进');
    cardRoute.promptLocal.segments[0].content = '卡专属修改';
    assert.equal(copy.segments[0].content, '慢节奏推进', '保存后的随卡副本不共享内存');
    assert.deepEqual(plain(P.read().presets), []);
});


test('提示词迁移：旧默认及名称选择转稳定引用，同名不同内容不覆盖，重复启动不重复导入', async () => {
    const host = settingsHost();
    const first = await storageWorld({ SillyTavern: host.SillyTavern }, world => {
        seedLegacyPrompts(world, [promptPreset('默认', '改过的默认'), promptPreset('剧情', '甲剧情')], ['', '剧情', '不存在']);
    });
    const P = first.run.core.promptStorage;
    const routes = await first.run.core.routes.read();
    assert.equal(P.resolve(routes[0]).segments[0].content, '改过的默认');
    assert.equal(P.resolve(routes[1]).segments[0].content, '甲剧情');
    assert.throws(() => P.resolve(routes[2]), /找不到了/);
    assert.equal(characterRoot(first.world).config.settings.routePromptPresets, undefined);
    const count = P.read().presets.length;
    const saves = host.state.saves;
    await first.store.read();
    assert.equal(P.read().presets.length, count);
    assert.equal(host.state.saves, saves);
    const second = await storageWorld({ SillyTavern: host.SillyTavern }, world => {
        world.helper.getCharData = () => ({ name: '角色乙' });
        seedLegacyPrompts(world, [promptPreset('剧情', '乙剧情')], ['剧情']);
    });
    const other = (await second.run.core.routes.read())[0];
    assert.notEqual(other.promptId, routes[1].promptId);
    assert.equal(P.resolve(other).segments[0].content, '乙剧情');
    assert.equal(P.resolve(routes[1]).segments[0].content, '甲剧情');
});

test('提示词迁移：用户库保存失败保留旧角色库；角色提交失败重试不重复，删除后不复活', async () => {
    const host = settingsHost();
    const first = await storageWorld({ SillyTavern: host.SillyTavern });
    seedLegacyPrompts(first.world, [promptPreset('待迁移')], ['待迁移']);
    const old = plain(first.world.state.variables);
    const save = host.context.saveSettingsDebounced;
    host.context.saveSettingsDebounced = () => false;
    await assert.rejects(first.store.read(), /已回滚/);
    assert.deepEqual(plain(first.world.state.variables), old);
    assert.equal(host.state.settings[API_SETTINGS_KEY], undefined);
    host.context.saveSettingsDebounced = save;
    const update = first.world.helper.updateVariablesWith;
    first.world.helper.updateVariablesWith = () => false;
    await assert.rejects(first.store.read(), /迁移保存失败/);
    assert.deepEqual(plain(first.world.state.variables), old);
    const P = first.run.core.promptStorage;
    assert.equal(P.read().presets.length, 1);
    const id = P.read().presets[0].id;
    await P.remove(id);
    first.world.helper.updateVariablesWith = update;
    await first.store.read();
    assert.equal(P.read().presets.length, 0);
    assert.equal((await first.run.core.routes.read())[0].promptId, id);
    assert.throws(() => P.resolve({ promptId: id }), /找不到了/);
});


test('提示词库：宿主未就绪、未知版本和保存失败拒绝写入，不污染 API 数据', async () => {
    const host = settingsHost();
    const run = load(null, { SillyTavern: host.SillyTavern }).core;
    await run.apiStorage.writePresets([sampleApiPreset('隔离')]);
    const P = run.promptStorage;
    const id = await P.save(promptPreset('原名'));
    const before = plain(host.state.settings);
    const save = host.context.saveSettingsDebounced;
    for (const fail of [() => { throw new Error(); }, async () => { throw new Error(); }, () => ({ saved: false })]) {
        host.context.saveSettingsDebounced = fail;
        await assert.rejects(P.save({ ...promptPreset('改名'), id }), /已回滚/);
        assert.deepEqual(plain(host.state.settings), before);
    }
    delete host.context.saveSettingsDebounced;
    await assert.rejects(P.remove(id), /接口不可用/);
    host.context.saveSettingsDebounced = save;
    await P.save({ ...promptPreset('恢复'), id });
    assert.equal(run.apiStorage.read().presets[0].key, 'test-secret-only');
    assert.doesNotMatch(JSON.stringify(P.read()), /test-secret-only/);
    const bad = { version: 99, presets: [], migrations: {} };
    host.state.settings[API_SETTINGS_KEY].promptStore = bad;
    await assert.rejects(P.save(promptPreset('不覆盖')), /版本不兼容/);
    assert.equal(host.state.settings[API_SETTINGS_KEY].promptStore, bad);
    const absent = load(null, { SillyTavern: null }).core.promptStorage;
    await assert.rejects(absent.save(promptPreset('等待')), /尚未就绪/);
});

test('提示词迁移：坏库不清空；空旧库不创建用户空信封；切角色不串写', async () => {
    const host = settingsHost();
    const { world, store, run } = await storageWorld({ SillyTavern: host.SillyTavern });
    characterRoot(world).config.settings.routePromptPresets = '坏库';
    await assert.rejects(store.read(), /格式异常/);
    assert.equal(characterRoot(world).config.settings.routePromptPresets, '坏库');
    characterRoot(world).config.settings.routePromptPresets = [];
    await store.read();
    assert.deepEqual(host.state.settings, {});
    assert.equal(characterRoot(world).config.settings.routePromptPresets, undefined);
    seedLegacyPrompts(world, [promptPreset('角色甲方案')], ['角色甲方案']);
    let resume;
    host.context.saveSettingsDebounced = () => new Promise(resolve => { resume = resolve; });
    const pending = assert.rejects(store.read(), /切换了角色或聊天/);
    await new Promise(setImmediate);
    world.helper.getCharData = () => ({ name: '另一个角色' });
    world.state.variables.character = { $dynamicGuideAssistant: { config: legacyConfig({ judgeInterval: 8 }) } };
    const changed = world.state.events.get('chat_changed')();
    resume();
    await pending;
    await changed;
    assert.equal(characterRoot(world).config.settings.judgeInterval, 8);
    assert.equal(characterRoot(world).routes, undefined);
    assert.equal(run.core.promptStorage.read().presets.length, 1, '已保存的用户方案保留，角色提交可重试');
});


test('提示词引用：缺失时拒绝模型请求，导入导出只携带提示词数据', async () => {
    let requests = 0;
    const { world, run } = await storageWorld({ fetch: async () => { requests += 1; throw new Error('不应请求'); } });
    const R = run.core.routes;
    const route = demoRoute(R).route;
    route.advance = 'judge';
    route.promptId = 'pmissing';
    world.state.messages = [{ message_id: 4, role: 'assistant', message: '正文' }];
    world.state.lastMessageId = 4;
    await run.core.apiStorage.writePresets([sampleApiPreset('接口')]);
    await R.setApi(route, '接口');
    await assert.rejects(R.judge(route, 4), /找不到了/);
    assert.equal(requests, 0);
    const P = run.core.promptStorage;
    const imported = P.import({ name: '剧情推进', promptGroup: [{ role: 'SYSTEM', content: '推进规则', enabled: false }], key: 'secret-test', rules: '第三方规则' });
    const exported = plain(P.export({ ...imported, key: 'secret-test', id: 'pold' }));
    assert.equal(exported.format, 'dynamic-guide-prompt');
    assert.equal(exported.version, 1);
    assert.equal(exported.segments[0].enabled, false);
    assert.doesNotMatch(JSON.stringify(exported), /secret-test|第三方规则|pold/);
    assert.deepEqual(plain(P.import(exported)), plain(imported));
    assert.throws(() => P.import({ format: 'dynamic-guide-prompt', version: 99, segments: imported.segments }), /不支持/);
});

test('提示词界面：侧边栏选一套再绑定至角色卡，下拉锁住；绑定的那套在设置页编辑，不改通用库', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const route = demoRoute(core.routes).route;
    route.advance = 'judge';
    route.worldbookName = '书A';
    characterRoot(world).routes = { version: 1, list: [plain(route)] };
    const { sandbox, errors } = loadWithDocument(documentRef, world.helper);
    const run = sandbox.DynamicGuideAssistantCore;
    let flushRouteSave;
    sandbox.setTimeout = (callback, delay) => { if (delay === 600) flushRouteSave = callback; return 1; };
    sandbox.clearTimeout = () => { flushRouteSave = null; };
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await run.refresh();
    const id = await run.promptStorage.save(promptPreset('共用规则', '共用正文'));
    const panel = () => documentRef.getElementById(PANEL_ID);
    findButton(panel().querySelector(`.dga-rt-card-${route.id}`).querySelector('.dga-rt-head'), '设置').listeners.click[0]();
    const drawer = () => panel().querySelector('.dga-rt-drawer');
    const nodes = (node, tag) => [node, ...(node.children || []).flatMap(child => nodes(child, tag))].filter(item => item.tagName === tag);
    const pick = () => nodes(drawer(), 'SELECT').find(item => item.textContent.includes('共用规则'));
    pick().listeners.change[0]({ target: { value: id } });
    assert.equal(nodes(drawer(), 'TEXTAREA').length, 0, '侧边栏里不放提示词编辑');
    findButton(drawer(), '绑定').listeners.click[0]();
    assert.equal(typeof flushRouteSave, 'function', '绑定触发真实延迟保存入口');
    flushRouteSave();
    await new Promise(setImmediate);
    const bound = characterRoot(world).routes.list[0].promptLocal;
    assert.equal(bound.segments[0].content, '共用正文', '绑定的是下拉里选中的那套');
    assert.equal(bound.name, '共用规则');
    assert.equal(bound.from, id);
    const locked = nodes(drawer(), 'SELECT').find(item => item.textContent.includes('共用规则'));
    assert.equal(locked.disabled, true, '绑定后上面的下拉锁住');
    assert.ok(findButton(drawer(), '解除绑定'));
    assert.equal(nodes(drawer(), 'TEXTAREA').length, 0);
    // 专用的那套到设置页「判断提示词」里改，和通用的同一套编辑器。
    findButton(panel().querySelector('.dga-rail'), '设置').listeners.click[0]();
    const editor = () => nodes(panel(), 'SELECT').find(item => item.textContent.includes('角色卡里的'));
    editor().listeners.change[0]({ target: { value: `local:${route.id}` } });
    nodes(panel(), 'TEXTAREA')[0].listeners.input[0]({ target: { value: '专属剧情要求', selectionStart: 0, selectionEnd: 0 } });
    await findButton(panel(), '保存当前提示词').listeners.click[0]();
    await new Promise(setImmediate);
    const stored = characterRoot(world).routes.list[0];
    assert.equal(stored.promptLocal.segments[0].content, '专属剧情要求');
    assert.equal(stored.promptId, undefined);
    assert.equal(run.promptStorage.resolve({ promptId: id }).segments[0].content, '共用正文', '不改通用库');
    // 解除绑定：删掉角色卡里那份，回到绑定前选的那套，下拉能选了。
    sandbox.confirm = () => true;
    findButton(panel().querySelector('.dga-rail'), route.name).listeners.click[0]();
    // 回到路线图页时侧边栏还开着。
    if (!drawer()) findButton(panel().querySelector(`.dga-rt-card-${route.id}`).querySelector('.dga-rt-head'), '设置').listeners.click[0]();
    findButton(drawer(), '解除绑定').listeners.click[0]();
    flushRouteSave();
    await new Promise(setImmediate);
    const after = characterRoot(world).routes.list[0];
    assert.equal(after.promptLocal, undefined);
    assert.equal(after.promptId, id);
    assert.equal(nodes(drawer(), 'SELECT').find(item => item.textContent.includes('共用规则')).disabled, false);
    assert.deepEqual(errors, []);
});



test('提示词：「默认」可以改，改过的存进通用库；改回原样就不单存', async () => {
    const run = load().core;
    const P = run.promptStorage;
    await P.saveDefault([{ role: 'system', content: '我改过的默认' }, { role: 'user', content: '{{作答表}}' }]);
    assert.equal(P.read().defaultSegments[0].content, '我改过的默认');
    assert.equal(P.resolve({}).segments[0].content, '我改过的默认', '没选提示词的路线图用改过的默认');
    assert.equal(run.routes.promptPresets()[0].segments[0].content, '我改过的默认');
    await assert.rejects(P.save({ name: '默认', segments: [{ role: 'user', content: 'x' }] }), /已经有叫「默认」/);
    await P.saveDefault(core.routes.promptPresets()[0].segments);
    assert.equal(P.read().defaultSegments, undefined, '和内置一样就不存');
});

test('路线图：左栏「新建路线图」能新建，世界书里多一个条目', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const { sandbox, errors } = loadWithDocument(documentRef, world.helper);
    const run = sandbox.DynamicGuideAssistantCore;
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await run.refresh();
    const panel = documentRef.getElementById(PANEL_ID);
    await findButton(panel.querySelector('.dga-rail'), '＋ 新建路线图').listeners.click[0]();
    for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
    const list = characterRoot(world).routes.list;
    assert.equal(list.length, 1);
    assert.equal(list[0].worldbookName, '书A');
    assert.ok(world.state.books.书A.some(entry => /（动态指导）$/.test(entry.name || entry.comment || '')), '世界书里有路线图条目');
    assert.doesNotMatch(documentRef.getElementById(PANEL_ID).textContent, /is not defined/);
    assert.deepEqual(errors, []);
});

test('界面：难懂的地方都有感叹号，说明不用专业词', async () => {
    const documentRef = fakeDocument('<body><div id="extensionsMenu"></div><button id="extensionsMenuButton"></button></body>');
    const world = routeWorld();
    const route = demoRoute(core.routes).route;
    route.advance = 'judge';
    route.worldbookName = '书A';
    characterRoot(world).routes = { version: 1, list: [plain(route)] };
    const { sandbox, errors } = loadWithDocument(documentRef, world.helper);
    const run = sandbox.DynamicGuideAssistantCore;
    await touchEntry(documentRef.getElementById('dynamic-guide-assistant-menu-item'));
    await run.refresh();
    const panel = () => documentRef.getElementById(PANEL_ID);
    const pops = () => findAllClass(panel(), 'dga-info-pop').map(node => node.textContent).join('\n');
    const head = () => panel().querySelector(`.dga-rt-card-${route.id}`).querySelector('.dga-rt-head');
    const seen = [];
    findButton(head(), '设置').listeners.click[0]();
    seen.push(pops());
    findButton(head(), '位置和顺序').listeners.click[0]();
    seen.push(pops());
    findButton(head(), '发给 AI 的内容').listeners.click[0]();
    seen.push(pops());
    findButton(panel().querySelector('.dga-rail'), '设置').listeners.click[0]();
    seen.push(pops());
    findButton(panel().querySelector('.dga-rail'), 'API').listeners.click[0]();
    seen.push(pops());
    const all = seen.join('\n');
    for (const word of ['只手动', '判断用的 API', '绑定至角色卡', '这是干嘛的', '按深度插入', '数字小的排前面', '格子', 'SYSTEM', '酒馆主 API']) {
        assert.ok(all.includes(word), `说明里讲到「${word}」`);
    }
    assert.doesNotMatch(all, /请求体|payload|endpoint|token|宏|正则|注入|上下文/i, '说明不用专业词');
    assert.deepEqual(errors, []);
});
