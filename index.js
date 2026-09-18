(function () {
    'use strict';

    const SCRIPT_NAME = '动态指导助手';
    const VERSION = '1.2';
    const VARIABLE_ROOT = '$dynamicGuideAssistant';
    const INJECTION_ID = 'dynamic-guide-assistant-current';
    const INSTANCE_KEY = '__dynamicGuideAssistantInstance';
    const COMPLETE_MARKER_RE = /<!--\s*DGA_COMPLETE:([a-z0-9_-]+)\s*-->/gi;
    const UI_PREFIX = 'dynamic-guide-assistant';
    const MENU_CONTAINER_ID = `${UI_PREFIX}-menu-container`;
    const MENU_ITEM_ID = `${UI_PREFIX}-menu-item`;
    const PANEL_ID = `${UI_PREFIX}-panel`;
    const STYLE_ID = `${UI_PREFIX}-style`;

    const currentWindow = typeof window !== 'undefined' ? window : globalThis;
    let hostWindow = currentWindow;
    try {
        if (currentWindow.frameElement && currentWindow.parent) {
            hostWindow = currentWindow.parent;
        }
    } catch (error) {
        hostWindow = currentWindow;
    }

    const helper = currentWindow.TavernHelper || hostWindow.TavernHelper || null;
    const instanceToken = `dga-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    currentWindow[INSTANCE_KEY] = instanceToken;

    function isCurrentInstance() {
        return currentWindow[INSTANCE_KEY] === instanceToken;
    }

    function hashText(text) {
        let hash = 2166136261;
        const source = String(text || '');
        for (let index = 0; index < source.length; index += 1) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    function normalizeText(text) {
        return String(text == null ? '' : text)
            .replace(/^\uFEFF/, '')
            .replace(/\r\n?/g, '\n');
    }

    function normalizeFieldKey(key) {
        return String(key || '')
            .toLowerCase()
            .replace(/\s+/g, '');
    }

    function fieldKind(key) {
        const normalized = normalizeFieldKey(key);
        const aliases = {
            type: ['类型', '内容类型', '分类'],
            show: ['什么时候出现', '出现时机', '出现条件', '开始条件', '触发时机', '触发条件'],
            prompt: ['告诉ai', '提示词', '指导内容', '内容', '发送给ai', '让ai知道'],
            hide: ['什么时候消失', '消失时机', '消失条件', '结束条件', '完成条件'],
            follow: ['跟随阶段', '所属阶段', '关联阶段'],
        };
        return Object.keys(aliases).find(kind => aliases[kind].includes(normalized)) || null;
    }

    function parseFieldLine(line) {
        const match = String(line || '').match(/^\s*([^：:\n]{1,20})\s*[：:]\s*(.*)$/);
        if (!match) return null;
        const kind = fieldKind(match[1]);
        return kind ? { kind, inlineValue: match[2] } : null;
    }

    function lineRecords(text) {
        const records = [];
        let offset = 0;
        for (const line of normalizeText(text).split('\n')) {
            records.push({ line, start: offset, end: offset + line.length });
            offset += line.length + 1;
        }
        return records;
    }

    function discoverBlockHeaders(text) {
        const records = lineRecords(text);
        const bracketHeaders = [];

        for (let index = 0; index < records.length; index += 1) {
            const record = records[index];
            const bracket = record.line.match(/^\s*[【\[]\s*(?:内容|剧情|阶段|指导)\s*[：:]\s*([^】\]\n]+?)\s*[】\]]\s*$/);
            if (bracket) {
                bracketHeaders.push({
                    title: bracket[1].trim(),
                    start: record.start,
                    bodyStart: record.end + 1,
                    lineIndex: index,
                });
            }
        }
        if (bracketHeaders.length > 0) return bracketHeaders;

        const markdownHeaders = [];
        for (let index = 0; index < records.length; index += 1) {
            const record = records[index];
            const markdown = record.line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
            if (!markdown || parseFieldLine(markdown[1])) continue;
            markdownHeaders.push({
                title: markdown[1].trim(),
                start: record.start,
                bodyStart: record.end + 1,
                lineIndex: index,
            });
        }
        if (markdownHeaders.length > 0) return markdownHeaders;

        const plainHeaders = [];
        for (let index = 0; index < records.length; index += 1) {
            const title = records[index].line.trim();
            if (!title || title.length > 80 || parseFieldLine(title)) continue;

            let nextIndex = index + 1;
            while (nextIndex < records.length && !records[nextIndex].line.trim()) {
                nextIndex += 1;
            }
            if (nextIndex < records.length && parseFieldLine(records[nextIndex].line)) {
                plainHeaders.push({
                    title,
                    start: records[index].start,
                    bodyStart: records[index].end + 1,
                    lineIndex: index,
                });
            }
        }
        return plainHeaders;
    }

    function parseBlockFields(body) {
        const fields = {
            type: '',
            show: '',
            prompt: '',
            hide: '',
            follow: '',
            intro: '',
        };
        const buckets = {
            type: [],
            show: [],
            prompt: [],
            hide: [],
            follow: [],
            intro: [],
        };
        let active = 'intro';

        for (const line of normalizeText(body).split('\n')) {
            const parsed = parseFieldLine(line);
            if (parsed) {
                active = parsed.kind;
                if (parsed.inlineValue) buckets[active].push(parsed.inlineValue);
                continue;
            }
            buckets[active].push(line);
        }

        Object.keys(fields).forEach(key => {
            fields[key] = buckets[key].join('\n').trim();
        });
        return fields;
    }

    function isMainType(type) {
        const normalized = String(type || '').trim();
        if (!normalized) return true;
        return /主线|剧情|阶段|章节/.test(normalized);
    }

    function parseGuideText(input) {
        const text = normalizeText(input);
        const headers = discoverBlockHeaders(text);
        const warnings = [];
        const blocks = [];

        if (headers.length === 0) {
            return {
                format: 'dynamic-guide-v1',
                blocks: [],
                mainBlocks: [],
                addonBlocks: [],
                warnings: ['没有找到内容标题。请使用“【内容：名称】”作为每段开头。'],
            };
        }

        for (let index = 0; index < headers.length; index += 1) {
            const header = headers[index];
            const next = headers[index + 1];
            const body = text.slice(header.bodyStart, next ? next.start : text.length).trim();
            const fields = parseBlockFields(body);
            const prompt = fields.prompt || fields.intro;

            if (!prompt) {
                warnings.push(`“${header.title}”没有“告诉AI”内容，已跳过。`);
                continue;
            }

            const main = isMainType(fields.type);
            const block = {
                id: `${main ? 'main' : 'addon'}-${index}-${hashText(`${header.title}\n${body}`)}`,
                sourceIndex: index,
                title: header.title,
                type: fields.type || (main ? '主线内容' : '附加内容'),
                kind: main ? 'main' : 'addon',
                whenShow: fields.show,
                prompt,
                whenHide: fields.hide,
                followStage: fields.follow,
                raw: body,
                mainIndex: -1,
                anchorMainIndex: -1,
            };
            blocks.push(block);
        }

        let seenMains = 0;
        for (const block of blocks) {
            if (block.kind === 'main') {
                block.mainIndex = seenMains;
                block.anchorMainIndex = seenMains;
                if (!block.whenShow) {
                    block.whenShow = seenMains === 0 ? '游戏开始时' : '上一段结束后';
                }
                if (!block.whenHide) {
                    block.whenHide = '手动推进，或由 AI 判断本段目标已经完成';
                }
                seenMains += 1;
            } else {
                block.anchorMainIndex = Math.max(0, seenMains - 1);
                if (block.followStage && !block.whenShow) {
                    block.whenShow = `《${block.followStage}》正在进行时`;
                }
            }
        }

        const mainBlocks = blocks.filter(block => block.kind === 'main');
        const addonBlocks = blocks.filter(block => block.kind === 'addon');
        if (mainBlocks.length === 0) {
            warnings.push('没有主线内容。至少需要一个未填写“类型”或类型为“主线/剧情/阶段”的内容块。');
        }

        return {
            format: 'dynamic-guide-v1',
            blocks,
            mainBlocks,
            addonBlocks,
            warnings,
        };
    }

    function normalizeCondition(value) {
        return String(value || '')
            .replace(/\s+/g, '')
            .replace(/[，。！？、；;,.!?]/g, '')
            .toLowerCase();
    }

    function stageToken(name) {
        return normalizeCondition(name)
            .replace(/第[一二三四五六七八九十百\d]+[章节幕段]/g, '')
            .replace(/进入|离开|来到|到达|前往|开始|结束|完成|阶段|剧情|章节/g, '');
    }

    function findStageIndex(condition, mainBlocks) {
        const source = normalizeCondition(condition);
        const quoted = String(condition || '').match(/[《「“"]([^》」”"]+)[》」”"]/);
        if (quoted) {
            const quotedName = normalizeCondition(quoted[1]);
            const exact = mainBlocks.findIndex(block => normalizeCondition(block.title) === quotedName);
            if (exact >= 0) return exact;
        }

        let best = -1;
        let bestLength = 0;
        mainBlocks.forEach((block, index) => {
            const full = normalizeCondition(block.title);
            const token = stageToken(block.title);
            if (full && source.includes(full) && full.length > bestLength) {
                best = index;
                bestLength = full.length;
            } else if (token.length >= 2 && source.includes(token) && token.length > bestLength) {
                best = index;
                bestLength = token.length;
            }
        });
        return best;
    }

    function addonStartReached(block, mainBlocks, currentIndex) {
        const condition = normalizeCondition(block.whenShow || block.followStage);
        if (!condition) return currentIndex === block.anchorMainIndex;
        if (/游戏开始|开局|一开始/.test(condition)) return currentIndex >= 0;
        if (/上一段结束|上一阶段结束|前一段结束/.test(condition)) {
            return currentIndex >= block.anchorMainIndex + 1;
        }

        const referencedIndex = findStageIndex(condition, mainBlocks);
        if (referencedIndex < 0) return currentIndex === block.anchorMainIndex;
        if (/结束后|完成后|之后/.test(condition)) return currentIndex > referencedIndex;
        return currentIndex >= referencedIndex;
    }

    function addonNotExpired(block, mainBlocks, currentIndex) {
        const condition = normalizeCondition(block.whenHide);
        const showCondition = normalizeCondition(block.whenShow || block.followStage);
        if (!condition) {
            const showIndex = findStageIndex(showCondition, mainBlocks);
            if (/正在进行|进行期间|阶段内|期间/.test(showCondition) && showIndex >= 0) {
                return currentIndex <= showIndex;
            }
            return true;
        }
        if (/游戏结束|故事结束|剧情结束/.test(condition)) {
            return currentIndex < mainBlocks.length;
        }

        const referencedIndex = findStageIndex(condition, mainBlocks);
        if (referencedIndex < 0) {
            return currentIndex === block.anchorMainIndex;
        }
        if (/进入|来到|到达|开始|出现/.test(condition) && !/结束|完成|离开/.test(condition)) {
            return currentIndex < referencedIndex;
        }
        return currentIndex <= referencedIndex;
    }

    function getActiveAddons(parsed, currentIndex) {
        if (!parsed || currentIndex < 0 || currentIndex >= parsed.mainBlocks.length) return [];
        return parsed.addonBlocks.filter(block => (
            addonStartReached(block, parsed.mainBlocks, currentIndex)
            && addonNotExpired(block, parsed.mainBlocks, currentIndex)
        ));
    }

    function formatInjection(mainBlock, addons) {
        if (!mainBlock) return '';
        const lines = [
            '[动态指导助手：当前有效内容]',
            '以下内容是作者为当前进度准备的内部创作指导。自然地遵守它，不要向用户提及指导系统、阶段编号、完成判定或隐藏标记。',
            '',
            `## 当前内容：${mainBlock.title}`,
            mainBlock.prompt,
        ];

        if (addons.length > 0) {
            lines.push('', '## 同时有效的附加内容');
            addons.forEach(block => {
                lines.push(
                    '',
                    `### ${block.title}（${block.type}）`,
                    block.prompt,
                );
                if (block.whenHide) {
                    lines.push(`有效期提示：${block.whenHide}`);
                }
            });
        }

        lines.push(
            '',
            '## 当前内容的完成判定',
            mainBlock.whenHide || '由作者手动推进',
            '',
            '只有当你确信“本次回复已经实际完成上述判定”时，才在回复末尾原样附加下面的 HTML 注释；尚未完成时不要附加：',
            `<!-- DGA_COMPLETE:${mainBlock.id} -->`,
        );
        return lines.join('\n');
    }

    function resolveValue(name) {
        const sources = [helper, currentWindow, hostWindow];
        for (const source of sources) {
            if (source && source[name] !== undefined) return source[name];
        }
        return undefined;
    }

    function resolveFunction(name, required) {
        const sources = [helper, currentWindow, hostWindow];
        for (const source of sources) {
            if (source && typeof source[name] === 'function') {
                return source[name].bind(source);
            }
        }
        if (required) throw new Error(`当前酒馆助手缺少 ${name} 接口`);
        return null;
    }

    function notify(message, type) {
        const level = type || 'info';
        const toast = hostWindow.toastr || currentWindow.toastr;
        if (toast && typeof toast[level] === 'function') {
            toast[level](message, SCRIPT_NAME);
        } else {
            const logger = level === 'error' ? console.error : (level === 'warning' ? console.warn : console.log);
            logger(`[${SCRIPT_NAME}] ${message}`);
        }
    }

    const reportedErrors = new Set();
    function reportOnce(key, message) {
        if (reportedErrors.has(key)) return;
        reportedErrors.add(key);
        notify(message, 'warning');
    }

    function getHostDocument() {
        try {
            return hostWindow.document || currentWindow.document || null;
        } catch (error) {
            return currentWindow.document || null;
        }
    }

    function getSillyTavernContext() {
        const candidates = [
            currentWindow.SillyTavern,
            hostWindow.SillyTavern,
            currentWindow.sillyTavern,
            hostWindow.sillyTavern,
        ];
        for (const candidate of candidates) {
            if (!candidate) continue;
            try {
                if (typeof candidate.getContext === 'function') {
                    const context = candidate.getContext();
                    if (context) return context;
                }
                if (candidate.characters || candidate.chat || candidate.characterId != null) {
                    return candidate;
                }
            } catch (error) {
                console.warn(`[${SCRIPT_NAME}] 读取 SillyTavern 上下文失败`, error);
            }
        }
        return null;
    }

    function characterFromContext(context) {
        if (!context || !Array.isArray(context.characters)) return null;
        const rawId = context.characterId != null ? context.characterId : context.this_chid;
        if (rawId == null || rawId === '') return null;
        const index = Number(rawId);
        return Number.isInteger(index) ? context.characters[index] || null : null;
    }

    async function getCurrentCharacterData() {
        const getCharData = resolveFunction('getCharData', false);
        if (getCharData) {
            try {
                const character = await Promise.resolve(getCharData('current'));
                if (character && typeof character === 'object') return character;
            } catch (error) {
                console.warn(`[${SCRIPT_NAME}] TavernHelper.getCharData('current') 失败`, error);
            }
        }
        return characterFromContext(getSillyTavernContext());
    }

    async function readVariables(type) {
        const getVariables = resolveFunction('getVariables', true);
        const variables = await Promise.resolve(getVariables({ type }));
        return variables && typeof variables === 'object' ? variables : {};
    }

    async function updateVariables(type, updater) {
        const updateVariablesWith = resolveFunction('updateVariablesWith', true);
        return Promise.resolve(updateVariablesWith(variables => {
            const safeVariables = variables && typeof variables === 'object' ? variables : {};
            return updater(safeVariables) || safeVariables;
        }, { type }));
    }

    async function readCharacterConfig() {
        const variables = await readVariables('character');
        const root = variables[VARIABLE_ROOT];
        return root && typeof root === 'object' ? root.config || null : null;
    }

    async function writeCharacterConfig(config) {
        return updateVariables('character', variables => {
            const root = variables[VARIABLE_ROOT] && typeof variables[VARIABLE_ROOT] === 'object'
                ? variables[VARIABLE_ROOT]
                : {};
            variables[VARIABLE_ROOT] = { ...root, config };
            return variables;
        });
    }

    async function readChatState() {
        const variables = await readVariables('chat');
        const root = variables[VARIABLE_ROOT];
        return root && typeof root === 'object' ? root.state || null : null;
    }

    async function writeChatState(state) {
        return updateVariables('chat', variables => {
            const root = variables[VARIABLE_ROOT] && typeof variables[VARIABLE_ROOT] === 'object'
                ? variables[VARIABLE_ROOT]
                : {};
            variables[VARIABLE_ROOT] = { ...root, state };
            return variables;
        });
    }

    function cleanWorldbookName(value) {
        return typeof value === 'string' && value.trim() ? value.trim() : '';
    }

    function namesFromList(value) {
        if (!Array.isArray(value)) return [];
        return value
            .map(item => {
                if (typeof item === 'string') return cleanWorldbookName(item);
                if (item && typeof item === 'object') {
                    return cleanWorldbookName(item.name || item.title || item.worldbookName);
                }
                return '';
            })
            .filter(Boolean);
    }

    function bindingParts(binding) {
        if (!binding) return { primary: null, additional: [] };
        if (typeof binding === 'string') {
            const name = cleanWorldbookName(binding);
            return { primary: name || null, additional: [] };
        }
        if (Array.isArray(binding)) {
            const names = namesFromList(binding);
            return {
                primary: names[0] || null,
                additional: names.slice(1),
            };
        }
        if (typeof binding !== 'object') return { primary: null, additional: [] };

        const primary = cleanWorldbookName(
            binding.primary
            || binding.world
            || binding.worldbook
            || binding.worldbookName,
        ) || null;
        const additional = [
            ...namesFromList(binding.additional),
            ...namesFromList(binding.worldbooks),
            ...namesFromList(binding.names),
            ...namesFromList(binding.books),
        ];
        if (binding.data && binding.data !== binding) {
            const nested = bindingParts(binding.data);
            return {
                primary: primary || nested.primary,
                additional: [...additional, nested.primary, ...nested.additional].filter(Boolean),
            };
        }
        return { primary, additional };
    }

    function worldbookNamesFromBinding(binding) {
        const parts = bindingParts(binding);
        return Array.from(new Set([parts.primary, ...parts.additional].filter(Boolean)));
    }

    function primaryWorldbookFromCharacter(character) {
        if (!character || typeof character !== 'object') return '';
        return cleanWorldbookName(
            character.data && character.data.extensions && character.data.extensions.world
            || character.extensions && character.extensions.world
            || character.world,
        );
    }

    function additionalWorldbooksFromCharacter(character) {
        if (!character || typeof character !== 'object') return [];
        return Array.from(new Set([
            ...namesFromList(character.data && character.data.extensions && character.data.extensions.worlds),
            ...namesFromList(character.data && character.data.extensions && character.data.extensions.additionalWorldbooks),
            ...namesFromList(character.extensions && character.extensions.worlds),
            ...namesFromList(character.extensions && character.extensions.additionalWorldbooks),
        ]));
    }

    let settingsBindingCache = {
        avatar: '',
        expiresAt: 0,
        names: [],
    };

    async function additionalWorldbooksFromSettings(character, context) {
        const avatar = cleanWorldbookName(
            character && (character.avatar || character.data && character.data.avatar),
        );
        if (!avatar) return [];
        const avatarBase = avatar.replace(/\.[^.]+$/, '');
        if (settingsBindingCache.avatar === avatarBase && settingsBindingCache.expiresAt > Date.now()) {
            return settingsBindingCache.names;
        }

        const fetchOwner = hostWindow && typeof hostWindow.fetch === 'function'
            ? hostWindow
            : currentWindow;
        if (!fetchOwner || typeof fetchOwner.fetch !== 'function') return [];

        try {
            const getRequestHeaders = context && typeof context.getRequestHeaders === 'function'
                ? context.getRequestHeaders.bind(context)
                : resolveFunction('getRequestHeaders', false);
            const requestHeaders = getRequestHeaders
                ? await Promise.resolve(getRequestHeaders())
                : {};
            const response = await fetchOwner.fetch('/api/settings/get', {
                method: 'POST',
                headers: {
                    ...(requestHeaders && typeof requestHeaders === 'object' ? requestHeaders : {}),
                    'Content-Type': 'application/json',
                },
                body: '{}',
            });
            if (!response.ok) return [];
            const payload = await response.json();
            const parsedSettings = typeof payload.settings === 'string'
                ? JSON.parse(payload.settings)
                : payload.settings;
            const charLore = parsedSettings
                && parsedSettings.world_info
                && Array.isArray(parsedSettings.world_info.charLore)
                ? parsedSettings.world_info.charLore
                : [];
            const matched = charLore.find(item => item && item.name === avatarBase);
            const names = namesFromList(matched && matched.extraBooks);
            settingsBindingCache = {
                avatar: avatarBase,
                expiresAt: Date.now() + 8000,
                names,
            };
            return names;
        } catch (error) {
            console.warn(`[${SCRIPT_NAME}] 读取角色附加世界书设置失败`, error);
            return [];
        }
    }

    async function getCharacterWorldbookBinding() {
        const context = getSillyTavernContext();
        const character = await getCurrentCharacterData();
        const names = [];
        const sources = [];
        let primary = null;

        function collect(raw, source) {
            const parts = bindingParts(raw);
            const collected = [parts.primary, ...parts.additional].filter(Boolean);
            if (collected.length === 0) return false;
            if (!primary && parts.primary) primary = parts.primary;
            names.push(...collected);
            sources.push(source);
            return true;
        }

        const characterCandidates = Array.from(new Set([
            'current',
            cleanWorldbookName(character && (character.name || character.data && character.data.name)),
            cleanWorldbookName(character && (character.avatar || character.data && character.data.avatar)),
        ].filter(Boolean)));

        const getCharWorldbookNames = resolveFunction('getCharWorldbookNames', false);
        if (getCharWorldbookNames) {
            for (const target of characterCandidates) {
                try {
                    const raw = await Promise.resolve(getCharWorldbookNames(target));
                    if (collect(raw, `TavernHelper:${target}`)) break;
                } catch (error) {
                    console.warn(`[${SCRIPT_NAME}] getCharWorldbookNames(${target}) 失败`, error);
                }
            }
        }

        const getCharLorebooks = resolveFunction('getCharLorebooks', false);
        if (getCharLorebooks && names.length === 0) {
            try {
                collect(
                    await Promise.resolve(getCharLorebooks({ type: 'all' })),
                    'TavernHelper:getCharLorebooks',
                );
            } catch (error) {
                console.warn(`[${SCRIPT_NAME}] getCharLorebooks 失败`, error);
            }
        }

        const nativePrimary = primaryWorldbookFromCharacter(character);
        if (nativePrimary) {
            if (!primary) primary = nativePrimary;
            names.push(nativePrimary);
            sources.push('角色卡原生绑定');
        }
        const embeddedAdditional = additionalWorldbooksFromCharacter(character);
        if (embeddedAdditional.length > 0) {
            names.push(...embeddedAdditional);
            sources.push('角色卡扩展字段');
        }
        const settingsAdditional = await additionalWorldbooksFromSettings(character, context);
        if (settingsAdditional.length > 0) {
            names.push(...settingsAdditional);
            sources.push('SillyTavern 附加世界书设置');
        }

        const orderedNames = Array.from(new Set([primary, ...names].filter(Boolean)));
        return {
            primary: primary || null,
            additional: orderedNames.filter(name => name !== primary),
            names: orderedNames,
            sources: Array.from(new Set(sources)),
            character,
            characterName: cleanWorldbookName(
                character && (character.name || character.data && character.data.name),
            ) || '当前角色',
            groupChat: Boolean(context && (context.groupId != null || context.selectedGroup)),
        };
    }

    async function getCharacterWorldbookNames() {
        return (await getCharacterWorldbookBinding()).names;
    }

    function entryName(entry) {
        return String(entry && (entry.comment || entry.name || entry.title || `条目 ${entry.uid}`) || '未命名条目');
    }

    function sameUid(left, right) {
        return left != null && right != null && String(left) === String(right);
    }

    function worldbookEntries(worldbook) {
        if (Array.isArray(worldbook)) return worldbook;
        if (!worldbook || typeof worldbook !== 'object') return [];
        if (Array.isArray(worldbook.entries)) return worldbook.entries;
        if (worldbook.entries && typeof worldbook.entries === 'object') {
            return Object.values(worldbook.entries);
        }
        return [];
    }

    function findEntry(worldbook, uid, name) {
        const entries = worldbookEntries(worldbook);
        return entries.find(entry => sameUid(entry.uid, uid))
            || entries.find(entry => entryName(entry) === name)
            || null;
    }

    function entryIsDisabled(entry) {
        if (!entry || typeof entry !== 'object') return false;
        if (typeof entry.enabled === 'boolean') return entry.enabled === false;
        if (typeof entry.disable === 'boolean') return entry.disable === true;
        return false;
    }

    async function getWorldbook(name) {
        const getter = resolveFunction('getWorldbook', true);
        return Promise.resolve(getter(name));
    }

    async function disableSourceEntry(worldbookName, uid, name) {
        const updateWorldbookWith = resolveFunction('updateWorldbookWith', true);
        let found = false;
        await Promise.resolve(updateWorldbookWith(worldbookName, worldbook => {
            const entry = findEntry(worldbook, uid, name);
            if (!entry) return worldbook;
            found = true;
            entry.enabled = false;
            if ('disable' in entry) entry.disable = true;
            return worldbook;
        }));
        if (!found) throw new Error(`无法在世界书“${worldbookName}”中找到来源条目`);

        const verified = findEntry(await getWorldbook(worldbookName), uid, name);
        if (!verified || !entryIsDisabled(verified)) {
            throw new Error('来源条目未能禁用。为防止完整剧情泄露，本次绑定已停止。');
        }
    }

    async function locateConfiguredEntry(config) {
        if (!config) return null;
        const boundNames = await getCharacterWorldbookNames();
        const candidates = Array.from(new Set([
            config.worldbookName,
            ...boundNames,
        ].filter(Boolean)));

        for (const worldbookName of candidates) {
            try {
                const worldbook = await getWorldbook(worldbookName);
                const entry = findEntry(worldbook, config.entryUid, config.entryName);
                if (entry) return { worldbookName, worldbook, entry };
            } catch (error) {
                console.warn(`[${SCRIPT_NAME}] 读取世界书“${worldbookName}”失败`, error);
            }
        }
        return null;
    }

    function makeSourceKey(source) {
        return `${source.worldbookName}::${source.entry.uid}::${hashText(source.entry.content)}`;
    }

    function reconcileState(rawState, parsed, sourceKey) {
        const oldState = rawState && typeof rawState === 'object' ? rawState : {};
        let mainIndex = Number.isInteger(oldState.mainIndex) ? oldState.mainIndex : 0;

        if (oldState.sourceKey !== sourceKey && oldState.mainName) {
            const matched = parsed.mainBlocks.findIndex(block => block.title === oldState.mainName);
            if (matched >= 0) mainIndex = matched;
        }
        mainIndex = Math.max(0, Math.min(mainIndex, parsed.mainBlocks.length));

        return {
            sourceKey,
            mainIndex,
            mainName: parsed.mainBlocks[mainIndex] ? parsed.mainBlocks[mainIndex].title : '',
            lastCompletionMessageId: oldState.lastCompletionMessageId == null
                ? null
                : oldState.lastCompletionMessageId,
            lastCompletionFingerprint: oldState.lastCompletionFingerprint || '',
            updatedAt: oldState.updatedAt || new Date().toISOString(),
        };
    }

    function statesDiffer(left, right) {
        return !left
            || left.sourceKey !== right.sourceKey
            || left.mainIndex !== right.mainIndex
            || left.mainName !== right.mainName
            || left.lastCompletionMessageId !== right.lastCompletionMessageId
            || left.lastCompletionFingerprint !== right.lastCompletionFingerprint;
    }

    async function loadContext(options) {
        const settings = options || {};
        const config = await readCharacterConfig();
        if (!config) return { configured: false };

        const source = await locateConfiguredEntry(config);
        if (!source) {
            throw new Error('找不到已绑定的动态指导条目。请重新点击“绑定指导页”。');
        }
        if (!entryIsDisabled(source.entry)) {
            await disableSourceEntry(source.worldbookName, source.entry.uid, entryName(source.entry));
            source.entry.enabled = false;
            if ('disable' in source.entry) source.entry.disable = true;
        }

        const parsed = parseGuideText(source.entry.content);
        if (parsed.mainBlocks.length === 0) {
            throw new Error(parsed.warnings.join('\n') || '指导页中没有可用的主线内容');
        }

        const sourceKey = makeSourceKey(source);
        const oldState = await readChatState();
        const state = reconcileState(oldState, parsed, sourceKey);
        if (settings.persistState !== false && statesDiffer(oldState, state)) {
            state.updatedAt = new Date().toISOString();
            await writeChatState(state);
        }

        const mainBlock = parsed.mainBlocks[state.mainIndex] || null;
        const addons = getActiveAddons(parsed, state.mainIndex);
        return {
            configured: true,
            config,
            source,
            parsed,
            state,
            mainBlock,
            addons,
        };
    }

    async function safeUninject() {
        const uninjectPrompts = resolveFunction('uninjectPrompts', false);
        if (uninjectPrompts) {
            await Promise.resolve(uninjectPrompts([INJECTION_ID]));
        }
    }

    async function injectCurrentGuide() {
        if (!isCurrentInstance()) return;
        const context = await loadContext();
        await safeUninject();
        if (!context.configured || !context.mainBlock) return;

        const injectPrompts = resolveFunction('injectPrompts', true);
        await Promise.resolve(injectPrompts([{
            id: INJECTION_ID,
            position: 'in_chat',
            depth: 0,
            role: 'system',
            content: formatInjection(context.mainBlock, context.addons),
            should_scan: false,
        }], { once: true }));
    }

    function stateForIndex(context, mainIndex, options) {
        const settings = options || {};
        const safeIndex = Math.max(0, Math.min(mainIndex, context.parsed.mainBlocks.length));
        return {
            sourceKey: makeSourceKey(context.source),
            mainIndex: safeIndex,
            mainName: context.parsed.mainBlocks[safeIndex]
                ? context.parsed.mainBlocks[safeIndex].title
                : '',
            lastCompletionMessageId: settings.messageId == null
                ? context.state.lastCompletionMessageId
                : settings.messageId,
            lastCompletionFingerprint: settings.completionFingerprint
                ? settings.completionFingerprint
                : context.state.lastCompletionFingerprint,
            updatedAt: new Date().toISOString(),
        };
    }

    async function moveToIndex(targetIndex, options) {
        const settings = options || {};
        const context = await loadContext();
        if (!context.configured) throw new Error('尚未绑定动态指导页');

        const nextState = stateForIndex(context, targetIndex, settings);
        await writeChatState(nextState);
        await safeUninject();

        const nextBlock = context.parsed.mainBlocks[nextState.mainIndex];
        if (settings.notify !== false) {
            if (nextBlock) {
                notify(`当前内容：${nextBlock.title}`, 'success');
            } else {
                notify('所有主线内容均已完成，后续不会再注入动态指导。', 'success');
            }
        }
        return nextState;
    }

    const managerState = {
        binding: null,
        context: null,
        entries: [],
        entryMap: new Map(),
        selectedWorldbook: '',
        selectedEntryKey: '',
        busy: false,
    };

    function managerElement(suffix) {
        const documentRef = getHostDocument();
        return documentRef ? documentRef.getElementById(`${UI_PREFIX}-${suffix}`) : null;
    }

    function setManagerText(suffix, value) {
        const element = managerElement(suffix);
        if (element) element.textContent = String(value == null ? '' : value);
    }

    function setManagerMessage(message, type) {
        const element = managerElement('message');
        if (!element) return;
        element.textContent = String(message || '');
        element.dataset.type = type || 'info';
        element.hidden = !message;
    }

    function setManagerBusy(busy) {
        managerState.busy = Boolean(busy);
        const panel = managerElement('panel');
        if (panel) panel.classList.toggle('dga-busy', managerState.busy);
        if (managerState.busy) {
            ['refresh', 'bind', 'previous', 'next', 'reset', 'worldbook-select', 'entry-select']
                .map(managerElement)
                .filter(Boolean)
                .forEach(element => {
                    element.disabled = true;
                });
        } else {
            updateManagerControls();
        }
    }

    function populateSelect(select, items, selectedValue, emptyLabel) {
        if (!select) return '';
        const documentRef = select.ownerDocument;
        select.replaceChildren();
        if (items.length === 0) {
            const option = documentRef.createElement('option');
            option.value = '';
            option.textContent = emptyLabel;
            select.appendChild(option);
            select.value = '';
            return '';
        }
        items.forEach(item => {
            const option = documentRef.createElement('option');
            option.value = item.value;
            option.textContent = item.label;
            select.appendChild(option);
        });
        const hasRequested = items.some(item => item.value === selectedValue);
        select.value = hasRequested ? selectedValue : items[0].value;
        return select.value;
    }

    function entryOptionKey(entry, index) {
        return entry && entry.uid != null ? `uid:${String(entry.uid)}` : `index:${index}`;
    }

    function entryOptionLabel(entry) {
        const parsed = parseGuideText(entry && entry.content);
        const stateLabel = entryIsDisabled(entry) ? ' · 已禁用' : '';
        if (parsed.mainBlocks.length === 0) {
            return `${entryName(entry)}（未识别到指导内容${stateLabel}）`;
        }
        return `${entryName(entry)}（${parsed.mainBlocks.length} 段主线，${parsed.addonBlocks.length} 段附加${stateLabel}）`;
    }

    function preferredEntryKey(entries, worldbookName, config, requestedKey) {
        const indexed = entries.map((entry, index) => ({
            entry,
            key: entryOptionKey(entry, index),
        }));
        if (requestedKey && indexed.some(item => item.key === requestedKey)) return requestedKey;
        if (config && config.worldbookName === worldbookName) {
            const configured = indexed.find(item => (
                sameUid(item.entry.uid, config.entryUid)
                || entryName(item.entry) === config.entryName
            ));
            if (configured) return configured.key;
        }
        const likelyGuide = indexed.find(item => (
            /动态指导|剧情指导|剧情流程/.test(entryName(item.entry))
            || /【\s*(?:内容|剧情|阶段|指导)\s*[：:]/.test(String(item.entry.content || ''))
        ));
        return likelyGuide ? likelyGuide.key : (indexed[0] ? indexed[0].key : '');
    }

    async function refreshEntryOptions(worldbookName, config, requestedKey) {
        const select = managerElement('entry-select');
        managerState.entries = [];
        managerState.entryMap = new Map();
        managerState.selectedEntryKey = '';
        if (!worldbookName) {
            populateSelect(select, [], '', '请先选择世界书');
            return;
        }

        const worldbook = await getWorldbook(worldbookName);
        const entries = worldbookEntries(worldbook);
        const items = entries.map((entry, index) => {
            const key = entryOptionKey(entry, index);
            managerState.entryMap.set(key, entry);
            return { value: key, label: entryOptionLabel(entry) };
        });
        const preferred = preferredEntryKey(entries, worldbookName, config, requestedKey);
        managerState.entries = entries;
        managerState.selectedEntryKey = populateSelect(select, items, preferred, '这个世界书没有条目');
    }

    function currentContentPreview(context) {
        if (!context || !context.configured) return '绑定一个指导条目后，这里会显示当前实际发送给 AI 的内容。';
        if (!context.mainBlock) return '所有主线内容均已完成，当前不会再发送动态指导。';
        const sections = [
            `【当前主线：${context.mainBlock.title}】`,
            context.mainBlock.prompt,
        ];
        context.addons.forEach(block => {
            sections.push('', `【附加：${block.title}｜${block.type}】`, block.prompt);
        });
        return sections.join('\n');
    }

    function renderManager(binding, config, context, contextError) {
        managerState.binding = binding;
        managerState.context = context;
        const detectedBooks = binding.names.length > 0 ? binding.names.join('、') : '未检测到';
        const detectionSources = binding.sources.length > 0 ? binding.sources.join('、') : '暂无可用来源';
        setManagerText('character-value', binding.characterName);
        setManagerText('worldbooks-value', detectedBooks);
        setManagerText('detection-value', detectionSources);

        if (context && context.configured) {
            const progress = context.mainBlock
                ? `${context.state.mainIndex + 1} / ${context.parsed.mainBlocks.length}`
                : `${context.parsed.mainBlocks.length} / ${context.parsed.mainBlocks.length}（已完成）`;
            setManagerText('binding-value', `${context.source.worldbookName} → ${entryName(context.source.entry)}`);
            setManagerText('progress-value', progress);
            setManagerText('current-title', context.mainBlock ? context.mainBlock.title : '主线已完成');
            setManagerText(
                'addons-value',
                context.addons.length > 0
                    ? context.addons.map(block => `${block.title}（${block.type}）`).join('、')
                    : '无',
            );
            setManagerText('preview', currentContentPreview(context));
            setManagerText(
                'warnings-value',
                context.parsed.warnings.length > 0 ? context.parsed.warnings.join('\n') : '无',
            );
        } else {
            const configuredLabel = config
                ? `${config.worldbookName || '未知世界书'} → ${config.entryName || '未知条目'}`
                : '尚未绑定';
            setManagerText('binding-value', configuredLabel);
            setManagerText('progress-value', '—');
            setManagerText('current-title', contextError ? '读取失败' : '等待绑定');
            setManagerText('addons-value', '无');
            setManagerText('preview', contextError || currentContentPreview(null));
            setManagerText('warnings-value', contextError || '无');
        }
        updateManagerControls();
    }

    function updateManagerControls() {
        if (managerState.busy) return;
        const context = managerState.context;
        const configured = Boolean(context && context.configured);
        const currentIndex = configured ? context.state.mainIndex : 0;
        const total = configured ? context.parsed.mainBlocks.length : 0;
        const worldbookSelect = managerElement('worldbook-select');
        const entrySelect = managerElement('entry-select');
        const refreshButton = managerElement('refresh');
        const bindButton = managerElement('bind');
        const previousButton = managerElement('previous');
        const nextButton = managerElement('next');
        const resetButton = managerElement('reset');
        if (refreshButton) refreshButton.disabled = false;
        if (worldbookSelect) worldbookSelect.disabled = !managerState.binding || managerState.binding.names.length === 0;
        if (entrySelect) entrySelect.disabled = managerState.entries.length === 0;
        if (bindButton) bindButton.disabled = !managerState.entryMap.has(managerState.selectedEntryKey);
        if (previousButton) previousButton.disabled = !configured || currentIndex <= 0;
        if (nextButton) nextButton.disabled = !configured || currentIndex >= total;
        if (resetButton) resetButton.disabled = !configured || currentIndex === 0;
    }

    async function refreshManager(options) {
        const settings = options || {};
        setManagerBusy(true);
        if (!settings.quiet) setManagerMessage('正在读取当前角色与世界书……', 'info');
        try {
            const [binding, config] = await Promise.all([
                getCharacterWorldbookBinding(),
                readCharacterConfig(),
            ]);
            const select = managerElement('worldbook-select');
            const requestedWorldbook = settings.worldbookName
                || managerState.selectedWorldbook
                || (config && config.worldbookName)
                || binding.primary
                || binding.names[0]
                || '';
            const selectedWorldbook = populateSelect(
                select,
                binding.names.map(name => ({ value: name, label: name })),
                requestedWorldbook,
                '当前角色没有绑定世界书',
            );
            managerState.selectedWorldbook = selectedWorldbook;

            let entryError = '';
            try {
                await refreshEntryOptions(
                    selectedWorldbook,
                    config,
                    settings.entryKey || managerState.selectedEntryKey,
                );
            } catch (error) {
                entryError = `读取世界书“${selectedWorldbook}”失败：${error.message || String(error)}`;
                populateSelect(managerElement('entry-select'), [], '', '无法读取条目');
            }

            let context = null;
            let contextError = '';
            try {
                context = await loadContext({ persistState: false });
            } catch (error) {
                contextError = error.message || String(error);
            }
            renderManager(binding, config, context, contextError);

            if (entryError) {
                setManagerMessage(entryError, 'error');
            } else if (binding.names.length === 0) {
                const extra = binding.groupChat
                    ? ' 当前是群聊；请切换到单角色聊天后绑定指导页。'
                    : ' 请确认世界书绑定在当前角色，而不是只设为全局世界书。';
                setManagerMessage(`没有检测到当前角色绑定的世界书。${extra}`, 'warning');
            } else if (contextError) {
                setManagerMessage(`已检测到世界书，但当前指导配置读取失败：${contextError}`, 'error');
            } else if (context && context.configured) {
                if (!settings.quiet) setManagerMessage('状态已刷新。', 'success');
            } else if (!settings.quiet) {
                setManagerMessage('请选择世界书和指导条目，然后点击“绑定所选条目”。', 'info');
            }
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 刷新管理页失败`, error);
            setManagerMessage(error.message || String(error), 'error');
        } finally {
            setManagerBusy(false);
        }
    }

    async function bindGuideEntry(worldbookName, selectedEntry) {
        if (!worldbookName || !selectedEntry) throw new Error('请先选择世界书和指导条目');
        const worldbook = await getWorldbook(worldbookName);
        const freshEntry = findEntry(worldbook, selectedEntry.uid, entryName(selectedEntry));
        if (!freshEntry) throw new Error('所选条目已经不存在，请刷新后重试');
        const parsed = parseGuideText(freshEntry.content);
        if (parsed.mainBlocks.length === 0) {
            throw new Error(parsed.warnings.join('\n') || '所选条目没有可用的主线内容');
        }

        const accepted = hostWindow.confirm(
            `绑定“${entryName(freshEntry)}”作为动态指导页？\n\n`
            + `主线内容：${parsed.mainBlocks.length} 段\n`
            + `附加内容：${parsed.addonBlocks.length} 段\n\n`
            + '绑定后会禁用这个世界书原条目，避免完整内容被直接发送给 AI。',
        );
        if (!accepted) return false;

        await disableSourceEntry(worldbookName, freshEntry.uid, entryName(freshEntry));
        freshEntry.enabled = false;
        if ('disable' in freshEntry) freshEntry.disable = true;
        const config = {
            format: 'dynamic-guide-v1',
            worldbookName,
            entryUid: freshEntry.uid,
            entryName: entryName(freshEntry),
            boundAt: new Date().toISOString(),
        };
        await writeCharacterConfig(config);
        const source = { worldbookName, entry: freshEntry };
        await writeChatState({
            sourceKey: makeSourceKey(source),
            mainIndex: 0,
            mainName: parsed.mainBlocks[0].title,
            lastCompletionMessageId: null,
            lastCompletionFingerprint: '',
            updatedAt: new Date().toISOString(),
        });
        await safeUninject();
        notify(`已绑定“${entryName(freshEntry)}”，当前内容：${parsed.mainBlocks[0].title}`, 'success');
        return true;
    }

    async function runManagerAction(pendingMessage, action, successMessage) {
        setManagerBusy(true);
        setManagerMessage(pendingMessage, 'info');
        try {
            const result = await action();
            if (result === false) return;
            await refreshManager({ quiet: true });
            setManagerMessage(successMessage, 'success');
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] ${pendingMessage}`, error);
            setManagerMessage(error.message || String(error), 'error');
            notify(error.message || String(error), 'error');
        } finally {
            setManagerBusy(false);
        }
    }

    function closeExtensionsMenu() {
        const documentRef = getHostDocument();
        if (!documentRef) return;
        const menu = documentRef.getElementById('extensionsMenu');
        const button = documentRef.getElementById('extensionsMenuButton');
        if (!menu || !button) return;
        try {
            const styles = hostWindow.getComputedStyle(menu);
            if (styles.display !== 'none' && styles.visibility !== 'hidden') button.click();
        } catch (error) {
            button.click();
        }
    }

    function closeManager() {
        const panel = managerElement('panel');
        if (panel) panel.hidden = true;
    }

    function managerStyles() {
        return `
#${PANEL_ID} {
    position: fixed;
    inset: 0;
    z-index: 100000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 18px;
    background: rgba(8, 10, 16, 0.68);
    backdrop-filter: blur(5px);
    color: var(--SmartThemeBodyColor, #ececf1);
}
#${PANEL_ID}[hidden] { display: none !important; }
#${PANEL_ID} * { box-sizing: border-box; }
#${PANEL_ID} .dga-shell {
    width: min(880px, 100%);
    max-height: min(88vh, 920px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 22%, transparent);
    border-radius: 16px;
    background: var(--SmartThemeBlurTintColor, rgba(28, 30, 38, 0.98));
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
}
#${PANEL_ID} .dga-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 16px 18px;
    border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 15%, transparent);
}
#${PANEL_ID} .dga-title { margin: 0; font-size: 1.15rem; }
#${PANEL_ID} .dga-subtitle { margin: 4px 0 0; opacity: 0.7; font-size: 0.86rem; }
#${PANEL_ID} .dga-close {
    min-width: 38px;
    min-height: 38px;
    border: 0;
    border-radius: 10px;
    color: inherit;
    background: rgba(255, 255, 255, 0.08);
    cursor: pointer;
    font-size: 1.4rem;
}
#${PANEL_ID} .dga-body { padding: 16px 18px 20px; overflow-y: auto; }
#${PANEL_ID} .dga-summary {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
}
#${PANEL_ID} .dga-card, #${PANEL_ID} .dga-section {
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 13%, transparent);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.045);
}
#${PANEL_ID} .dga-card { padding: 11px 12px; }
#${PANEL_ID} .dga-card span { display: block; opacity: 0.68; font-size: 0.78rem; margin-bottom: 5px; }
#${PANEL_ID} .dga-card strong { display: block; overflow-wrap: anywhere; }
#${PANEL_ID} .dga-section { margin-top: 12px; padding: 14px; }
#${PANEL_ID} .dga-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
}
#${PANEL_ID} .dga-section h3 { margin: 0; font-size: 0.98rem; }
#${PANEL_ID} .dga-help { margin: 0 0 12px; opacity: 0.72; font-size: 0.84rem; line-height: 1.55; }
#${PANEL_ID} .dga-fields { display: grid; grid-template-columns: 1fr 1.35fr; gap: 10px; }
#${PANEL_ID} label { display: grid; gap: 6px; font-size: 0.82rem; opacity: 0.88; }
#${PANEL_ID} select, #${PANEL_ID} button.dga-button {
    width: 100%;
    min-height: 40px;
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 18%, transparent);
    border-radius: 9px;
    color: inherit;
    background: var(--SmartThemeBotMesBlurTintColor, rgba(20, 22, 28, 0.85));
}
#${PANEL_ID} select { padding: 8px 10px; }
#${PANEL_ID} button.dga-button { padding: 8px 13px; cursor: pointer; font-weight: 650; }
#${PANEL_ID} button.dga-primary {
    background: var(--SmartThemeQuoteColor, #7b62d9);
    color: #fff;
    border-color: transparent;
}
#${PANEL_ID} button:disabled, #${PANEL_ID} select:disabled { opacity: 0.45; cursor: not-allowed; }
#${PANEL_ID} .dga-actions { display: flex; gap: 9px; margin-top: 11px; }
#${PANEL_ID} .dga-actions .dga-button { flex: 1; }
#${PANEL_ID} .dga-preview {
    margin: 10px 0 0;
    max-height: 230px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 12px;
    border-radius: 9px;
    background: rgba(0, 0, 0, 0.18);
    font: inherit;
    font-size: 0.86rem;
    line-height: 1.58;
}
#${PANEL_ID} .dga-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; font-size: 0.84rem; }
#${PANEL_ID} .dga-meta b { opacity: 0.72; font-weight: 500; }
#${PANEL_ID} .dga-message { margin-top: 12px; padding: 10px 12px; border-radius: 9px; font-size: 0.86rem; line-height: 1.5; }
#${PANEL_ID} .dga-message[data-type="info"] { background: rgba(80, 140, 220, 0.15); }
#${PANEL_ID} .dga-message[data-type="success"] { background: rgba(70, 180, 115, 0.16); }
#${PANEL_ID} .dga-message[data-type="warning"] { background: rgba(230, 165, 60, 0.16); }
#${PANEL_ID} .dga-message[data-type="error"] { background: rgba(220, 75, 85, 0.17); }
#${PANEL_ID}.dga-busy .dga-shell { cursor: progress; }
@media (max-width: 680px) {
    #${PANEL_ID} { padding: 0; align-items: stretch; }
    #${PANEL_ID} .dga-shell { width: 100%; max-height: 100vh; min-height: 100vh; border-radius: 0; }
    #${PANEL_ID} .dga-summary, #${PANEL_ID} .dga-fields, #${PANEL_ID} .dga-meta { grid-template-columns: 1fr; }
    #${PANEL_ID} .dga-actions { flex-wrap: wrap; }
    #${PANEL_ID} .dga-actions .dga-button { flex: 1 1 42%; }
}`;
    }

    function installManagerUi(force) {
        const documentRef = getHostDocument();
        if (!documentRef || !documentRef.body) return null;
        if (force) {
            const oldPanel = documentRef.getElementById(PANEL_ID);
            const oldStyle = documentRef.getElementById(STYLE_ID);
            if (oldPanel) oldPanel.remove();
            if (oldStyle) oldStyle.remove();
        }
        const existing = documentRef.getElementById(PANEL_ID);
        if (existing) return existing;

        const style = documentRef.createElement('style');
        style.id = STYLE_ID;
        style.textContent = managerStyles();
        (documentRef.head || documentRef.documentElement).appendChild(style);

        const panel = documentRef.createElement('div');
        panel.id = PANEL_ID;
        panel.hidden = true;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', `${UI_PREFIX}-dialog-title`);
        panel.innerHTML = `
<div class="dga-shell" tabindex="-1">
    <header class="dga-header">
        <div>
            <h2 class="dga-title" id="${UI_PREFIX}-dialog-title">动态指导助手</h2>
            <p class="dga-subtitle">管理角色绑定、当前剧情与聊天进度 · v${VERSION}</p>
        </div>
        <button class="dga-close" id="${UI_PREFIX}-close" type="button" aria-label="关闭">×</button>
    </header>
    <div class="dga-body">
        <section class="dga-summary" aria-label="当前状态">
            <div class="dga-card"><span>当前角色</span><strong id="${UI_PREFIX}-character-value">读取中</strong></div>
            <div class="dga-card"><span>检测到的角色世界书</span><strong id="${UI_PREFIX}-worldbooks-value">读取中</strong></div>
            <div class="dga-card"><span>已绑定指导页</span><strong id="${UI_PREFIX}-binding-value">读取中</strong></div>
            <div class="dga-card"><span>当前聊天进度</span><strong id="${UI_PREFIX}-progress-value">读取中</strong></div>
        </section>

        <section class="dga-section">
            <div class="dga-section-head">
                <h3>绑定指导页</h3>
                <button class="dga-button" id="${UI_PREFIX}-refresh" type="button">刷新</button>
            </div>
            <p class="dga-help">这里仅列出当前角色绑定的世界书。绑定后，来源条目会自动禁用，避免整页剧情被原生世界书直接发送给 AI。</p>
            <div class="dga-fields">
                <label>角色世界书
                    <select id="${UI_PREFIX}-worldbook-select"><option>读取中</option></select>
                </label>
                <label>剧情或指导条目
                    <select id="${UI_PREFIX}-entry-select"><option>读取中</option></select>
                </label>
            </div>
            <div class="dga-actions">
                <button class="dga-button dga-primary" id="${UI_PREFIX}-bind" type="button">绑定所选条目</button>
            </div>
        </section>

        <section class="dga-section">
            <div class="dga-section-head"><h3 id="${UI_PREFIX}-current-title">当前发送内容</h3></div>
            <div class="dga-meta">
                <div><b>同时有效的附加内容：</b><span id="${UI_PREFIX}-addons-value">无</span></div>
                <div><b>绑定识别来源：</b><span id="${UI_PREFIX}-detection-value">读取中</span></div>
                <div><b>解析提醒：</b><span id="${UI_PREFIX}-warnings-value">无</span></div>
            </div>
            <pre class="dga-preview" id="${UI_PREFIX}-preview">读取中</pre>
        </section>

        <section class="dga-section">
            <div class="dga-section-head"><h3>当前聊天进度</h3></div>
            <div class="dga-actions">
                <button class="dga-button" id="${UI_PREFIX}-previous" type="button">上一段</button>
                <button class="dga-button dga-primary" id="${UI_PREFIX}-next" type="button">下一段</button>
                <button class="dga-button" id="${UI_PREFIX}-reset" type="button">重置到第一段</button>
            </div>
        </section>
        <div class="dga-message" id="${UI_PREFIX}-message" data-type="info" hidden></div>
    </div>
</div>`;
        documentRef.body.appendChild(panel);

        managerElement('close').onclick = closeManager;
        panel.onclick = event => {
            if (event.target === panel) closeManager();
        };
        panel.onkeydown = event => {
            if (event.key === 'Escape') closeManager();
        };
        managerElement('refresh').onclick = () => refreshManager();
        managerElement('worldbook-select').onchange = event => {
            managerState.selectedWorldbook = event.target.value;
            managerState.selectedEntryKey = '';
            refreshManager({ worldbookName: event.target.value, entryKey: '', quiet: true });
        };
        managerElement('entry-select').onchange = event => {
            managerState.selectedEntryKey = event.target.value;
            updateManagerControls();
        };
        managerElement('bind').onclick = () => {
            const entry = managerState.entryMap.get(managerState.selectedEntryKey);
            runManagerAction(
                '正在绑定所选指导条目……',
                () => bindGuideEntry(managerState.selectedWorldbook, entry),
                '绑定完成，当前聊天已从第一段开始。',
            );
        };
        managerElement('previous').onclick = () => runManagerAction(
            '正在切换到上一段……',
            async () => {
                const context = await loadContext();
                return moveToIndex(context.state.mainIndex - 1);
            },
            '已切换到上一段。',
        );
        managerElement('next').onclick = () => runManagerAction(
            '正在切换到下一段……',
            async () => {
                const context = await loadContext();
                return moveToIndex(context.state.mainIndex + 1);
            },
            '已切换到下一段。',
        );
        managerElement('reset').onclick = () => runManagerAction(
            '正在重置当前聊天进度……',
            async () => {
                if (!hostWindow.confirm('把当前聊天的动态指导进度重置到第一段？')) return false;
                return moveToIndex(0);
            },
            '当前聊天已重置到第一段。',
        );
        return panel;
    }

    async function openManager() {
        const panel = installManagerUi(false);
        if (!panel) throw new Error('管理页面尚未准备好，请稍后重试');
        closeExtensionsMenu();
        panel.hidden = false;
        const shell = panel.querySelector('.dga-shell');
        if (shell) shell.focus();
        await refreshManager();
    }

    function registerMenuEntry(retry) {
        if (!isCurrentInstance()) return;
        const documentRef = getHostDocument();
        const menu = documentRef && documentRef.getElementById('extensionsMenu');
        if (!documentRef || !documentRef.body || !menu) {
            if ((retry || 0) < 30) {
                hostWindow.setTimeout(() => registerMenuEntry((retry || 0) + 1), 1000);
            } else {
                reportOnce('魔法棒入口', '找不到酒馆左下角魔法棒菜单，未能添加“动态指导助手”入口。');
            }
            return;
        }

        let container = documentRef.getElementById(MENU_CONTAINER_ID);
        if (!container) {
            container = documentRef.createElement('div');
            container.id = MENU_CONTAINER_ID;
            container.className = 'extension_container interactable';
            container.tabIndex = 0;
            menu.appendChild(container);
        }
        let item = documentRef.getElementById(MENU_ITEM_ID);
        if (!item) {
            item = documentRef.createElement('div');
            item.id = MENU_ITEM_ID;
            item.className = 'list-group-item flex-container flexGap5 interactable';
            item.title = '打开动态指导助手';
            item.innerHTML = '<div class="fa-fw fa-solid fa-book-open extensionsMenuExtensionButton"></div><span>动态指导助手</span>';
            container.replaceChildren(item);
        }
        item.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            runEventTask('打开管理页面', openManager);
        };
    }

    async function bindGuide() {
        return openManager();
    }

    async function showStatus() {
        return openManager();
    }

    async function next() {
        try {
            const context = await loadContext();
            if (!context.configured) throw new Error('尚未绑定动态指导页');
            await moveToIndex(context.state.mainIndex + 1);
        } catch (error) {
            notify(error.message || String(error), 'error');
        }
    }

    async function previous() {
        try {
            const context = await loadContext();
            if (!context.configured) throw new Error('尚未绑定动态指导页');
            await moveToIndex(context.state.mainIndex - 1);
        } catch (error) {
            notify(error.message || String(error), 'error');
        }
    }

    async function reset() {
        try {
            const context = await loadContext();
            if (!context.configured) throw new Error('尚未绑定动态指导页');
            if (!hostWindow.confirm('把当前聊天的动态指导进度重置到第一段？')) return;
            await moveToIndex(0);
        } catch (error) {
            notify(error.message || String(error), 'error');
        }
    }

    function messageIdFromEvent(args) {
        for (const value of args) {
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (value && typeof value === 'object' && Number.isFinite(value.message_id)) {
                return value.message_id;
            }
        }
        return null;
    }

    async function handleMessageReceived() {
        if (!isCurrentInstance()) return;
        const args = Array.from(arguments);
        const getLastMessageId = resolveFunction('getLastMessageId', true);
        const getChatMessages = resolveFunction('getChatMessages', true);
        const requestedId = messageIdFromEvent(args);
        const messageId = requestedId == null ? getLastMessageId() : requestedId;
        const messages = await Promise.resolve(getChatMessages(messageId, { include_swipes: false }));
        const message = Array.isArray(messages) ? messages[0] : null;
        if (!message || message.role !== 'assistant' || typeof message.message !== 'string') return;

        const markers = Array.from(message.message.matchAll(COMPLETE_MARKER_RE));
        if (markers.length === 0) return;

        const context = await loadContext();
        if (!context.configured || !context.mainBlock) return;
        const hasCurrentMarker = markers.some(match => match[1] === context.mainBlock.id);
        const cleaned = message.message.replace(COMPLETE_MARKER_RE, '').trimEnd();
        const completionFingerprint = `${messageId}:${context.mainBlock.id}:${hashText(cleaned)}`;
        const alreadyHandled = context.state.lastCompletionFingerprint === completionFingerprint;
        const setChatMessages = resolveFunction('setChatMessages', false);
        if (setChatMessages && cleaned !== message.message) {
            await Promise.resolve(setChatMessages(
                [{ message_id: messageId, message: cleaned }],
                { refresh: 'affected' },
            ));
        }

        if (hasCurrentMarker && !alreadyHandled) {
            await moveToIndex(context.state.mainIndex + 1, {
                messageId,
                completionFingerprint,
            });
        }
    }

    function runEventTask(label, task) {
        Promise.resolve()
            .then(() => {
                if (!isCurrentInstance()) return;
                return task();
            })
            .catch(error => {
                console.error(`[${SCRIPT_NAME}] ${label}失败`, error);
                reportOnce(label, `${label}失败：${error.message || String(error)}`);
            });
    }

    async function removeLegacyScriptButtons() {
        const legacyNames = new Set([
            '绑定指导页',
            '查看当前内容',
            '下一段',
            '上一段',
            '重置进度',
        ]);
        const updateScriptButtonsWith = resolveFunction('updateScriptButtonsWith', false);
        if (updateScriptButtonsWith) {
            await Promise.resolve(updateScriptButtonsWith(buttons => (
                Array.isArray(buttons) ? buttons.filter(button => !legacyNames.has(button && button.name)) : []
            )));
            return;
        }
        const getScriptButtons = resolveFunction('getScriptButtons', false);
        const replaceScriptButtons = resolveFunction('replaceScriptButtons', false);
        if (getScriptButtons && replaceScriptButtons) {
            const buttons = await Promise.resolve(getScriptButtons());
            await Promise.resolve(replaceScriptButtons(
                Array.isArray(buttons) ? buttons.filter(button => !legacyNames.has(button && button.name)) : [],
            ));
        }
    }

    const publicApi = {
        version: VERSION,
        parseGuideText,
        getActiveAddons,
        formatInjection,
        bindGuide,
        showStatus,
        openManager,
        refreshManager,
        getCharacterWorldbookBinding,
        next,
        previous,
        reset,
        getCurrentSnapshot: () => loadContext({ persistState: false }),
    };
    currentWindow.DynamicGuideAssistantCore = publicApi;

    if (!helper) {
        console.warn(`[${SCRIPT_NAME}] 未检测到 JS-Slash-Runner / TavernHelper；仅开放纯解析器。`);
        return;
    }

    installManagerUi(true);
    registerMenuEntry(0);
    runEventTask('清理旧版脚本按钮', removeLegacyScriptButtons);

    const eventOn = resolveFunction('eventOn', false);
    const tavernEvents = resolveValue('tavern_events');
    if (!eventOn) {
        reportOnce('事件监听', '当前酒馆助手缺少事件接口，管理页面可用，但无法自动注入内容。');
        return;
    }
    if (!tavernEvents) {
        reportOnce('事件监听', '当前酒馆助手缺少酒馆事件表，管理页面可用，但无法自动注入内容。');
        return;
    }

    if (tavernEvents.GENERATION_AFTER_COMMANDS) {
        eventOn(tavernEvents.GENERATION_AFTER_COMMANDS, () => {
            runEventTask('注入当前内容', injectCurrentGuide);
        });
    } else {
        reportOnce('生成事件', '找不到 GENERATION_AFTER_COMMANDS 事件，无法自动注入内容。');
    }

    if (tavernEvents.MESSAGE_RECEIVED) {
        eventOn(tavernEvents.MESSAGE_RECEIVED, function () {
            const args = arguments;
            runEventTask('处理完成标记', () => handleMessageReceived.apply(null, args));
        });
    }

    if (tavernEvents.CHAT_CHANGED) {
        eventOn(tavernEvents.CHAT_CHANGED, () => {
            runEventTask('切换聊天', async () => {
                await safeUninject();
                const panel = managerElement('panel');
                if (panel && !panel.hidden) await refreshManager({ quiet: true });
            });
        });
    }
})();
