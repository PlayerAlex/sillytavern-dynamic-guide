(function () {
    'use strict';

    const SCRIPT_NAME = '动态指导助手';
    const VERSION = '1.1';
    const VARIABLE_ROOT = '$dynamicGuideAssistant';
    const INJECTION_ID = 'dynamic-guide-assistant-current';
    const INSTANCE_KEY = '__dynamicGuideAssistantInstance';
    const COMPLETE_MARKER_RE = /<!--\s*DGA_COMPLETE:([a-z0-9_-]+)\s*-->/gi;

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

    function worldbookNamesFromBinding(binding) {
        if (!binding) return [];
        if (typeof binding === 'string') return [binding];
        const names = [];
        if (binding.primary) names.push(binding.primary);
        if (Array.isArray(binding.additional)) names.push(...binding.additional);
        if (Array.isArray(binding.worldbooks)) names.push(...binding.worldbooks);
        return Array.from(new Set(names.filter(Boolean)));
    }

    async function getCharacterWorldbookNames() {
        const getCharWorldbookNames = resolveFunction('getCharWorldbookNames', true);
        const binding = await Promise.resolve(getCharWorldbookNames('current'));
        return worldbookNamesFromBinding(binding);
    }

    function entryName(entry) {
        return String(entry && (entry.comment || entry.name || entry.title || `条目 ${entry.uid}`) || '未命名条目');
    }

    function sameUid(left, right) {
        return left != null && right != null && String(left) === String(right);
    }

    function findEntry(worldbook, uid, name) {
        const entries = worldbook && Array.isArray(worldbook.entries) ? worldbook.entries : [];
        return entries.find(entry => sameUid(entry.uid, uid))
            || entries.find(entry => entryName(entry) === name)
            || null;
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
            return worldbook;
        }));
        if (!found) throw new Error(`无法在世界书“${worldbookName}”中找到来源条目`);

        const verified = findEntry(await getWorldbook(worldbookName), uid, name);
        if (!verified || verified.enabled !== false) {
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
        if (source.entry.enabled !== false) {
            await disableSourceEntry(source.worldbookName, source.entry.uid, entryName(source.entry));
            source.entry.enabled = false;
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

    async function bindGuide() {
        try {
            const names = await getCharacterWorldbookNames();
            if (names.length === 0) {
                throw new Error('当前角色没有绑定世界书。请先把指导页放进角色绑定世界书。');
            }

            const candidates = [];
            for (const worldbookName of names) {
                const worldbook = await getWorldbook(worldbookName);
                const entries = worldbook && Array.isArray(worldbook.entries) ? worldbook.entries : [];
                entries.forEach(entry => candidates.push({ worldbookName, entry }));
            }
            if (candidates.length === 0) throw new Error('角色绑定世界书中没有条目');

            const list = candidates
                .map((candidate, index) => `${index + 1}. [${candidate.worldbookName}] ${entryName(candidate.entry)}`)
                .join('\n');
            const preferredIndex = candidates.findIndex(candidate => (
                /动态指导|剧情指导|剧情流程/.test(entryName(candidate.entry))
                || /【\s*(?:内容|剧情|阶段|指导)\s*[：:]/.test(String(candidate.entry.content || ''))
            ));
            const answer = hostWindow.prompt(
                `请选择要作为动态指导页的条目，输入序号：\n\n${list}`,
                String((preferredIndex >= 0 ? preferredIndex : 0) + 1),
            );
            if (answer == null) return;

            const selectedIndex = Number.parseInt(answer, 10) - 1;
            const selected = candidates[selectedIndex];
            if (!selected) throw new Error('输入的条目序号无效');

            const parsed = parseGuideText(selected.entry.content);
            if (parsed.mainBlocks.length === 0) {
                throw new Error(parsed.warnings.join('\n') || '所选条目没有可用内容');
            }

            const accepted = hostWindow.confirm(
                `绑定“${entryName(selected.entry)}”作为动态指导页？\n\n`
                + `主线内容：${parsed.mainBlocks.length} 段\n`
                + `附加内容：${parsed.addonBlocks.length} 段\n\n`
                + '绑定后会禁用这个世界书原条目，避免完整内容被直接发送给 AI。',
            );
            if (!accepted) return;

            await disableSourceEntry(selected.worldbookName, selected.entry.uid, entryName(selected.entry));
            const config = {
                format: 'dynamic-guide-v1',
                worldbookName: selected.worldbookName,
                entryUid: selected.entry.uid,
                entryName: entryName(selected.entry),
                boundAt: new Date().toISOString(),
            };
            await writeCharacterConfig(config);

            const source = {
                worldbookName: selected.worldbookName,
                entry: selected.entry,
            };
            await writeChatState({
                sourceKey: makeSourceKey(source),
                mainIndex: 0,
                mainName: parsed.mainBlocks[0].title,
                lastCompletionMessageId: null,
                lastCompletionFingerprint: '',
                updatedAt: new Date().toISOString(),
            });
            await safeUninject();

            const warningText = parsed.warnings.length > 0
                ? `\n\n解析提醒：\n- ${parsed.warnings.join('\n- ')}`
                : '';
            notify(`已绑定“${entryName(selected.entry)}”，当前内容：${parsed.mainBlocks[0].title}${warningText}`, 'success');
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 绑定失败`, error);
            notify(error.message || String(error), 'error');
        }
    }

    async function showStatus() {
        try {
            const context = await loadContext();
            if (!context.configured) {
                hostWindow.alert('尚未绑定动态指导页。\n\n请先点击“绑定指导页”。');
                return;
            }

            const progress = context.mainBlock
                ? `${context.state.mainIndex + 1} / ${context.parsed.mainBlocks.length}`
                : `${context.parsed.mainBlocks.length} / ${context.parsed.mainBlocks.length}（已完成）`;
            const addonText = context.addons.length > 0
                ? context.addons.map(block => `- ${block.title}（${block.type}）`).join('\n')
                : '- 无';
            const warnings = context.parsed.warnings.length > 0
                ? `\n\n解析提醒：\n- ${context.parsed.warnings.join('\n- ')}`
                : '';

            hostWindow.alert(
                `动态指导页：${entryName(context.source.entry)}\n`
                + `进度：${progress}\n`
                + `当前内容：${context.mainBlock ? context.mainBlock.title : '无'}\n\n`
                + `当前附加内容：\n${addonText}${warnings}`,
            );
        } catch (error) {
            notify(error.message || String(error), 'error');
        }
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

    function installScriptButtons(eventOn) {
        const appendButtons = resolveFunction('appendInexistentScriptButtons', false);
        const getButtonEvent = resolveFunction('getButtonEvent', false);
        if (!appendButtons || !getButtonEvent) {
            reportOnce('脚本按钮', '当前酒馆助手缺少动态按钮接口，请导入完整 JSON 版本使用。');
            return;
        }

        const buttons = [
            { name: '绑定指导页', handler: bindGuide },
            { name: '查看当前内容', handler: showStatus },
            { name: '下一段', handler: next },
            { name: '上一段', handler: previous },
            { name: '重置进度', handler: reset },
        ];
        appendButtons(buttons.map(button => ({
            name: button.name,
            visible: true,
        })));
        buttons.forEach(button => {
            eventOn(getButtonEvent(button.name), () => {
                runEventTask(`执行“${button.name}”`, button.handler);
            });
        });
    }

    const publicApi = {
        version: VERSION,
        parseGuideText,
        getActiveAddons,
        formatInjection,
        bindGuide,
        showStatus,
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

    const eventOn = resolveFunction('eventOn', false);
    const tavernEvents = resolveValue('tavern_events');
    if (!eventOn) {
        reportOnce('事件监听', '当前酒馆助手缺少事件接口，无法注册按钮或自动注入内容。');
        return;
    }
    installScriptButtons(eventOn);
    if (!tavernEvents) {
        reportOnce('事件监听', '当前酒馆助手缺少酒馆事件表，按钮可用，但无法自动注入内容。');
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
            runEventTask('切换聊天', safeUninject);
        });
    }
})();
