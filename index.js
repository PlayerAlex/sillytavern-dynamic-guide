(function () {
    'use strict';

    const SCRIPT_NAME = '动态指导助手';
    const VERSION = '1.3';
    const VARIABLE_ROOT = '$dynamicGuideAssistant';
    const INJECTION_ID = 'dynamic-guide-assistant-current';
    const INSTANCE_KEY = '__dynamicGuideAssistantInstance';
    const COMPLETE_MARKER_RE = /<!--\s*DGA_COMPLETE:([a-z0-9_-]+)\s*-->/gi;
    const UI_PREFIX = 'dynamic-guide-assistant';
    const MENU_CONTAINER_ID = `${UI_PREFIX}-menu-container`;
    const MENU_ITEM_ID = `${UI_PREFIX}-menu-item`;
    const PANEL_ID = `${UI_PREFIX}-panel`;
    const EDITOR_ID = `${UI_PREFIX}-stage-editor`;
    const STYLE_ID = `${UI_PREFIX}-style`;
    const LAYOUT_META_KEY = 'dynamicGuideAssistant';
    const LAYOUT_VERSION = 1;
    const DEFAULT_STAGE_COLORS = [
        '#8b5cf6',
        '#3b82f6',
        '#14b8a6',
        '#f59e0b',
        '#ef4444',
        '#ec4899',
        '#84cc16',
        '#06b6d4',
    ];

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

    function normalizeColor(value, fallback) {
        const color = String(value || '').trim();
        if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
        if (/^#[0-9a-f]{3}$/i.test(color)) {
            return `#${color.slice(1).split('').map(character => character + character).join('')}`.toLowerCase();
        }
        return fallback || DEFAULT_STAGE_COLORS[0];
    }

    function getRangeLayout(entry) {
        const extra = entry && entry.extra && typeof entry.extra === 'object' ? entry.extra : null;
        const metadata = extra && extra[LAYOUT_META_KEY] && typeof extra[LAYOUT_META_KEY] === 'object'
            ? extra[LAYOUT_META_KEY]
            : null;
        const layout = metadata && metadata.layout && typeof metadata.layout === 'object'
            ? metadata.layout
            : null;
        if (!layout || layout.mode !== 'ranges') return null;
        return layout;
    }

    function makeStageId() {
        return `stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function completionMarkerId(stage, index) {
        const source = String(stage && stage.id || '')
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return source || `stage-${index + 1}-${hashText(stage && stage.name || String(index)).slice(0, 6)}`;
    }

    function clampOffset(value, textLength) {
        const number = Number(value);
        if (!Number.isFinite(number)) return 0;
        return Math.max(0, Math.min(Math.trunc(number), textLength));
    }

    function createAnchoredRange(text, start, end) {
        const normalizedText = normalizeText(text);
        const safeStart = clampOffset(Math.min(start, end), normalizedText.length);
        const safeEnd = clampOffset(Math.max(start, end), normalizedText.length);
        return {
            start: safeStart,
            end: safeEnd,
            quote: normalizedText.slice(safeStart, safeEnd),
            prefix: normalizedText.slice(Math.max(0, safeStart - 32), safeStart),
            suffix: normalizedText.slice(safeEnd, Math.min(normalizedText.length, safeEnd + 32)),
        };
    }

    function allTextOccurrences(text, quote) {
        const positions = [];
        if (!quote) return positions;
        let offset = 0;
        while (offset <= text.length - quote.length) {
            const found = text.indexOf(quote, offset);
            if (found < 0) break;
            positions.push(found);
            offset = found + Math.max(1, quote.length);
        }
        return positions;
    }

    function resolveAnchoredRange(text, rawRange) {
        const normalizedText = normalizeText(text);
        if (!rawRange || typeof rawRange !== 'object') return null;
        const quote = String(rawRange.quote || '');
        const storedStart = clampOffset(rawRange.start, normalizedText.length);
        const storedEnd = clampOffset(rawRange.end, normalizedText.length);
        if (storedEnd > storedStart) {
            const direct = normalizedText.slice(storedStart, storedEnd);
            if (!quote || direct === quote) {
                return {
                    start: storedStart,
                    end: storedEnd,
                    quote: direct,
                    reanchored: false,
                };
            }
        }
        if (!quote) return null;

        const prefix = String(rawRange.prefix || '');
        const suffix = String(rawRange.suffix || '');
        const candidates = allTextOccurrences(normalizedText, quote);
        if (candidates.length === 0) return null;
        let best = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        candidates.forEach(position => {
            let score = -Math.abs(position - storedStart);
            if (prefix) {
                const actualPrefix = normalizedText.slice(Math.max(0, position - prefix.length), position);
                if (actualPrefix === prefix) score += 100000;
            }
            if (suffix) {
                const actualSuffix = normalizedText.slice(position + quote.length, position + quote.length + suffix.length);
                if (actualSuffix === suffix) score += 100000;
            }
            if (score > bestScore) {
                bestScore = score;
                best = position;
            }
        });
        return best == null ? null : {
            start: best,
            end: best + quote.length,
            quote,
            reanchored: best !== storedStart,
        };
    }

    function resolveRangeList(text, ranges) {
        const resolved = [];
        let unresolvedCount = 0;
        let reanchoredCount = 0;
        (Array.isArray(ranges) ? ranges : []).forEach(range => {
            const result = resolveAnchoredRange(text, range);
            if (!result || result.end <= result.start) {
                unresolvedCount += 1;
                return;
            }
            if (result.reanchored) reanchoredCount += 1;
            resolved.push(result);
        });
        resolved.sort((left, right) => left.start - right.start || left.end - right.end);
        return { resolved, unresolvedCount, reanchoredCount };
    }

    function resolveRangeLayout(text, layout) {
        const normalizedText = normalizeText(text);
        const stages = (Array.isArray(layout && layout.stages) ? layout.stages : []).map((stage, index) => {
            const rangeResult = resolveRangeList(normalizedText, stage && stage.ranges);
            return {
                id: String(stage && stage.id || `stage-${index + 1}-${hashText(stage && stage.name || String(index)).slice(0, 6)}`),
                name: String(stage && stage.name || `阶段 ${index + 1}`).trim() || `阶段 ${index + 1}`,
                color: normalizeColor(stage && stage.color, DEFAULT_STAGE_COLORS[index % DEFAULT_STAGE_COLORS.length]),
                completion: String(stage && stage.completion || '').trim(),
                ranges: rangeResult.resolved,
                unresolvedCount: rangeResult.unresolvedCount,
                reanchoredCount: rangeResult.reanchoredCount,
            };
        });
        const alwaysSource = layout && layout.always && typeof layout.always === 'object' ? layout.always : {};
        const alwaysResult = resolveRangeList(normalizedText, alwaysSource.ranges);
        return {
            sourceHashMatches: String(layout && layout.sourceHash || '') === hashText(normalizedText),
            stages,
            always: {
                color: normalizeColor(alwaysSource.color, '#64748b'),
                ranges: alwaysResult.resolved,
                unresolvedCount: alwaysResult.unresolvedCount,
                reanchoredCount: alwaysResult.reanchoredCount,
            },
        };
    }

    function textFromResolvedRanges(text, ranges) {
        const normalizedText = normalizeText(text);
        return (Array.isArray(ranges) ? ranges : [])
            .map(range => normalizedText.slice(range.start, range.end).trim())
            .filter(Boolean)
            .join('\n\n');
    }

    function parseGuideEntry(entry) {
        const layout = getRangeLayout(entry);
        if (!layout) return parseGuideText(entry && entry.content);

        const text = normalizeText(entry && entry.content);
        const resolved = resolveRangeLayout(text, layout);
        const warnings = [];
        const blocks = [];
        resolved.stages.forEach((stage, index) => {
            const prompt = textFromResolvedRanges(text, stage.ranges);
            if (!prompt) {
                warnings.push(`“${stage.name}”没有可用的文字选区，已跳过。`);
                return;
            }
            if (stage.unresolvedCount > 0) {
                warnings.push(`“${stage.name}”有 ${stage.unresolvedCount} 个选区无法重新定位，请打开阶段标注器检查。`);
            }
            const mainIndex = blocks.filter(block => block.kind === 'main').length;
            blocks.push({
                id: completionMarkerId(stage, index),
                sourceIndex: index,
                title: stage.name,
                type: '主线阶段',
                kind: 'main',
                whenShow: mainIndex === 0 ? '游戏开始时' : '上一段结束后',
                prompt,
                whenHide: stage.completion || '手动推进，或由 AI 判断本阶段大纲已经完成',
                followStage: '',
                raw: prompt,
                mainIndex,
                anchorMainIndex: mainIndex,
                color: stage.color,
            });
        });

        const mainBlocks = blocks.filter(block => block.kind === 'main');
        const alwaysPrompt = textFromResolvedRanges(text, resolved.always.ranges);
        if (resolved.always.unresolvedCount > 0) {
            warnings.push(`常驻提示有 ${resolved.always.unresolvedCount} 个选区无法重新定位，请打开阶段标注器检查。`);
        }
        if (alwaysPrompt) {
            blocks.push({
                id: `always-${hashText(alwaysPrompt)}`,
                sourceIndex: -1,
                title: '常驻提示',
                type: '常驻提示',
                kind: 'addon',
                whenShow: '游戏开始时',
                prompt: alwaysPrompt,
                whenHide: '故事结束时',
                followStage: '',
                raw: alwaysPrompt,
                mainIndex: -1,
                anchorMainIndex: 0,
                color: resolved.always.color,
            });
        }
        const addonBlocks = blocks.filter(block => block.kind === 'addon');
        if (mainBlocks.length === 0) {
            warnings.push('可视化布局中没有可用的剧情阶段。请打开阶段标注器，为至少一个阶段选择提示词。');
        }
        if (!resolved.sourceHashMatches) {
            const reanchoredCount = resolved.stages.reduce((sum, stage) => sum + stage.reanchoredCount, 0)
                + resolved.always.reanchoredCount;
            if (reanchoredCount > 0) {
                warnings.push(`提示词原文发生过修改，已自动重新定位 ${reanchoredCount} 个选区。`);
            }
        }
        return {
            format: 'dynamic-guide-ranges-v1',
            blocks,
            mainBlocks,
            addonBlocks,
            warnings,
            layout,
            layoutResolution: resolved,
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

    async function writeRangeLayout(worldbookName, selectedEntry, layout) {
        if (!worldbookName || !selectedEntry) throw new Error('没有可保存的世界书条目');
        const updateWorldbookWith = resolveFunction('updateWorldbookWith', true);
        let found = false;
        await Promise.resolve(updateWorldbookWith(worldbookName, worldbook => {
            const entry = findEntry(worldbook, selectedEntry.uid, entryName(selectedEntry));
            if (!entry) return worldbook;
            found = true;
            const extra = entry.extra && typeof entry.extra === 'object' ? entry.extra : {};
            const metadata = extra[LAYOUT_META_KEY] && typeof extra[LAYOUT_META_KEY] === 'object'
                ? extra[LAYOUT_META_KEY]
                : {};
            entry.extra = {
                ...extra,
                [LAYOUT_META_KEY]: {
                    ...metadata,
                    layout,
                },
            };
            return worldbook;
        }));
        if (!found) throw new Error(`无法在世界书“${worldbookName}”中找到要保存的指导条目`);
        const verified = findEntry(
            await getWorldbook(worldbookName),
            selectedEntry.uid,
            entryName(selectedEntry),
        );
        const savedLayout = getRangeLayout(verified);
        if (!verified || !savedLayout || savedLayout.sourceHash !== layout.sourceHash) {
            throw new Error('阶段划分未能写入世界书条目的隐藏扩展数据');
        }
        return verified;
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
        const layout = getRangeLayout(source.entry);
        const layoutHash = layout ? hashText(JSON.stringify(layout)) : 'template';
        return `${source.worldbookName}::${source.entry.uid}::${hashText(source.entry.content)}::${layoutHash}`;
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

        const parsed = parseGuideEntry(source.entry);
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

    const stageEditorState = {
        worldbookName: '',
        entry: null,
        text: '',
        stages: [],
        alwaysColor: '#64748b',
        alwaysRanges: [],
        activeOwnerId: '',
        pendingRange: null,
        selectedMarkedRange: null,
        unresolvedCount: 0,
        dirty: false,
        busy: false,
    };

    function editorElement(suffix) {
        const documentRef = getHostDocument();
        return documentRef ? documentRef.getElementById(`${UI_PREFIX}-editor-${suffix}`) : null;
    }

    function setEditorMessage(message, type) {
        const element = editorElement('message');
        if (!element) return;
        element.textContent = String(message || '');
        element.dataset.type = type || 'info';
        element.hidden = !message;
    }

    function setEditorBusy(busy) {
        stageEditorState.busy = Boolean(busy);
        const editor = getHostDocument() && getHostDocument().getElementById(EDITOR_ID);
        if (editor) editor.classList.toggle('dga-busy', stageEditorState.busy);
        ['save', 'save-bind', 'new-stage', 'assign', 'assign-always', 'clear-range']
            .map(editorElement)
            .filter(Boolean)
            .forEach(element => {
                element.disabled = stageEditorState.busy;
            });
        if (!stageEditorState.busy) updateStageEditorControls();
    }

    function normalizedIntervals(ranges) {
        const textLength = stageEditorState.text.length;
        const sorted = (Array.isArray(ranges) ? ranges : [])
            .map(range => ({
                start: clampOffset(Math.min(range.start, range.end), textLength),
                end: clampOffset(Math.max(range.start, range.end), textLength),
            }))
            .filter(range => range.end > range.start)
            .sort((left, right) => left.start - right.start || left.end - right.end);
        const merged = [];
        sorted.forEach(range => {
            const previous = merged[merged.length - 1];
            if (previous && range.start <= previous.end) {
                previous.end = Math.max(previous.end, range.end);
            } else {
                merged.push({ ...range });
            }
        });
        return merged;
    }

    function subtractInterval(ranges, start, end) {
        const result = [];
        normalizedIntervals(ranges).forEach(range => {
            if (range.end <= start || range.start >= end) {
                result.push(range);
                return;
            }
            if (range.start < start) result.push({ start: range.start, end: start });
            if (range.end > end) result.push({ start: end, end: range.end });
        });
        return normalizedIntervals(result);
    }

    function activeStage() {
        return stageEditorState.stages.find(stage => stage.id === stageEditorState.activeOwnerId) || null;
    }

    function ownerRanges(ownerId) {
        if (ownerId === 'always') return stageEditorState.alwaysRanges;
        const stage = stageEditorState.stages.find(item => item.id === ownerId);
        return stage ? stage.ranges : [];
    }

    function setOwnerRanges(ownerId, ranges) {
        const normalized = normalizedIntervals(ranges);
        if (ownerId === 'always') {
            stageEditorState.alwaysRanges = normalized;
            return;
        }
        const stage = stageEditorState.stages.find(item => item.id === ownerId);
        if (stage) stage.ranges = normalized;
    }

    function clearRangeFromAllOwners(start, end) {
        stageEditorState.stages.forEach(stage => {
            stage.ranges = subtractInterval(stage.ranges, start, end);
        });
        stageEditorState.alwaysRanges = subtractInterval(stageEditorState.alwaysRanges, start, end);
    }

    function assignRangeToOwner(ownerId, start, end) {
        clearRangeFromAllOwners(start, end);
        setOwnerRanges(ownerId, [...ownerRanges(ownerId), { start, end }]);
    }

    function ownerColor(ownerId) {
        if (ownerId === 'always') return stageEditorState.alwaysColor;
        const stage = stageEditorState.stages.find(item => item.id === ownerId);
        return stage ? stage.color : '#64748b';
    }

    function ownerName(ownerId) {
        if (ownerId === 'always') return '常驻提示';
        const stage = stageEditorState.stages.find(item => item.id === ownerId);
        return stage ? (stage.name || '未命名阶段') : '未知阶段';
    }

    function colorToRgba(color, alpha) {
        const normalized = normalizeColor(color, '#64748b').slice(1);
        const red = Number.parseInt(normalized.slice(0, 2), 16);
        const green = Number.parseInt(normalized.slice(2, 4), 16);
        const blue = Number.parseInt(normalized.slice(4, 6), 16);
        return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    }

    function markStageEditorDirty() {
        stageEditorState.dirty = true;
        const indicator = editorElement('dirty');
        if (indicator) indicator.hidden = false;
    }

    function clearNativeSelection() {
        try {
            const selection = hostWindow.getSelection && hostWindow.getSelection();
            if (selection && typeof selection.removeAllRanges === 'function') selection.removeAllRanges();
        } catch (error) {
            console.warn(`[${SCRIPT_NAME}] 清理文字选择失败`, error);
        }
    }

    function setActiveOwner(ownerId) {
        stageEditorState.activeOwnerId = ownerId;
        stageEditorState.selectedMarkedRange = null;
        renderStageEditorSidebar();
        renderStageEditorSettings();
        renderStageEditorText();
        updateStageEditorControls();
    }

    function addStage() {
        const index = stageEditorState.stages.length;
        const stage = {
            id: makeStageId(),
            name: `阶段 ${index + 1}`,
            color: DEFAULT_STAGE_COLORS[index % DEFAULT_STAGE_COLORS.length],
            completion: '',
            ranges: [],
        };
        stageEditorState.stages.push(stage);
        markStageEditorDirty();
        setActiveOwner(stage.id);
        const nameInput = editorElement('stage-name');
        if (nameInput) {
            nameInput.focus();
            nameInput.select();
        }
    }

    function moveActiveStage(direction) {
        const index = stageEditorState.stages.findIndex(stage => stage.id === stageEditorState.activeOwnerId);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= stageEditorState.stages.length) return;
        const [stage] = stageEditorState.stages.splice(index, 1);
        stageEditorState.stages.splice(target, 0, stage);
        markStageEditorDirty();
        renderStageEditorSidebar();
        renderStageEditorSettings();
    }

    function deleteActiveStage() {
        const stage = activeStage();
        if (!stage) return;
        if (!hostWindow.confirm(`删除“${stage.name}”阶段？被标记的文字会恢复为未分配。`)) return;
        const index = stageEditorState.stages.findIndex(item => item.id === stage.id);
        stageEditorState.stages.splice(index, 1);
        stageEditorState.activeOwnerId = stageEditorState.stages[index]
            ? stageEditorState.stages[index].id
            : (stageEditorState.stages[index - 1] ? stageEditorState.stages[index - 1].id : 'always');
        markStageEditorDirty();
        renderStageEditorSidebar();
        renderStageEditorSettings();
        renderStageEditorText();
        updateStageEditorControls();
    }

    function allEditorMarks() {
        const marks = [];
        stageEditorState.stages.forEach(stage => {
            normalizedIntervals(stage.ranges).forEach(range => marks.push({
                ...range,
                ownerId: stage.id,
                color: stage.color,
                name: stage.name,
            }));
        });
        normalizedIntervals(stageEditorState.alwaysRanges).forEach(range => marks.push({
            ...range,
            ownerId: 'always',
            color: stageEditorState.alwaysColor,
            name: '常驻提示',
        }));
        return marks.sort((left, right) => left.start - right.start || left.end - right.end);
    }

    function renderStageEditorSidebar() {
        const list = editorElement('stage-list');
        if (!list) return;
        const documentRef = list.ownerDocument;
        list.replaceChildren();

        function appendOwnerButton(ownerId, name, color, rangeCount, indexLabel) {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.className = 'dga-stage-item';
            if (stageEditorState.activeOwnerId === ownerId) button.classList.add('is-active');
            button.style.setProperty('--dga-stage-color', normalizeColor(color, '#64748b'));
            const title = documentRef.createElement('strong');
            title.textContent = indexLabel ? `${indexLabel} · ${name}` : name;
            const count = documentRef.createElement('span');
            count.textContent = `${rangeCount} 处提示词`;
            button.append(title, count);
            button.onclick = () => setActiveOwner(ownerId);
            list.appendChild(button);
        }

        stageEditorState.stages.forEach((stage, index) => {
            appendOwnerButton(
                stage.id,
                stage.name || '未命名阶段',
                stage.color,
                stage.ranges.length,
                `阶段 ${index + 1}`,
            );
        });
        appendOwnerButton(
            'always',
            '常驻提示',
            stageEditorState.alwaysColor,
            stageEditorState.alwaysRanges.length,
            '',
        );
    }

    function renderStageEditorSettings() {
        const stage = activeStage();
        const isAlways = stageEditorState.activeOwnerId === 'always';
        const title = editorElement('settings-title');
        const nameWrap = editorElement('stage-name-wrap');
        const completionWrap = editorElement('completion-wrap');
        const orderActions = editorElement('order-actions');
        const deleteButton = editorElement('delete-stage');
        const nameInput = editorElement('stage-name');
        const completionInput = editorElement('stage-completion');
        const colorInput = editorElement('stage-color');
        if (title) title.textContent = isAlways ? '常驻提示设置' : (stage ? `${stage.name}设置` : '阶段设置');
        if (nameWrap) nameWrap.hidden = isAlways || !stage;
        if (completionWrap) completionWrap.hidden = isAlways || !stage;
        if (orderActions) orderActions.hidden = isAlways || !stage;
        if (deleteButton) deleteButton.hidden = isAlways || !stage;
        if (nameInput) nameInput.value = stage ? stage.name : '';
        if (completionInput) completionInput.value = stage ? stage.completion : '';
        if (colorInput) colorInput.value = normalizeColor(
            isAlways ? stageEditorState.alwaysColor : stage && stage.color,
            isAlways ? '#64748b' : DEFAULT_STAGE_COLORS[0],
        );
        const stageIndex = stage ? stageEditorState.stages.findIndex(item => item.id === stage.id) : -1;
        const moveUp = editorElement('move-up');
        const moveDown = editorElement('move-down');
        if (moveUp) moveUp.disabled = stageIndex <= 0;
        if (moveDown) moveDown.disabled = stageIndex < 0 || stageIndex >= stageEditorState.stages.length - 1;
    }

    function renderStageEditorText() {
        const surface = editorElement('surface');
        if (!surface) return;
        const documentRef = surface.ownerDocument;
        const oldScrollTop = surface.scrollTop;
        surface.replaceChildren();
        const text = stageEditorState.text;
        const marks = allEditorMarks();
        let cursor = 0;
        marks.forEach(mark => {
            const start = Math.max(cursor, mark.start);
            const end = Math.max(start, mark.end);
            if (start > cursor) surface.appendChild(documentRef.createTextNode(text.slice(cursor, start)));
            if (end > start) {
                const span = documentRef.createElement('span');
                span.className = 'dga-text-mark';
                if (mark.ownerId === stageEditorState.activeOwnerId) span.classList.add('is-active');
                const selected = stageEditorState.selectedMarkedRange;
                if (selected
                    && selected.ownerId === mark.ownerId
                    && selected.start === mark.start
                    && selected.end === mark.end) {
                    span.classList.add('is-selected');
                }
                span.dataset.ownerId = mark.ownerId;
                span.dataset.start = String(mark.start);
                span.dataset.end = String(mark.end);
                span.style.setProperty('--dga-mark-color', normalizeColor(mark.color, '#64748b'));
                span.style.backgroundColor = colorToRgba(mark.color, mark.ownerId === stageEditorState.activeOwnerId ? 0.38 : 0.22);
                span.title = mark.name;
                span.textContent = text.slice(start, end);
                surface.appendChild(span);
            }
            cursor = Math.max(cursor, end);
        });
        if (cursor < text.length) surface.appendChild(documentRef.createTextNode(text.slice(cursor)));
        if (!text) surface.textContent = '这个世界书条目没有提示词内容。';
        surface.scrollTop = oldScrollTop;
    }

    function selectionOffsetsInSurface() {
        const surface = editorElement('surface');
        const documentRef = getHostDocument();
        if (!surface || !documentRef || !hostWindow.getSelection) return null;
        const selection = hostWindow.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
        const range = selection.getRangeAt(0);
        if (!surface.contains(range.startContainer) || !surface.contains(range.endContainer)) return null;
        const beforeStart = documentRef.createRange();
        beforeStart.selectNodeContents(surface);
        beforeStart.setEnd(range.startContainer, range.startOffset);
        const beforeEnd = documentRef.createRange();
        beforeEnd.selectNodeContents(surface);
        beforeEnd.setEnd(range.endContainer, range.endOffset);
        const start = clampOffset(beforeStart.toString().length, stageEditorState.text.length);
        const end = clampOffset(beforeEnd.toString().length, stageEditorState.text.length);
        if (end <= start) return null;
        return { start, end, quote: stageEditorState.text.slice(start, end) };
    }

    function captureStageEditorSelection() {
        const result = selectionOffsetsInSurface();
        if (!result) return;
        stageEditorState.pendingRange = result;
        stageEditorState.selectedMarkedRange = null;
        const preview = result.quote.replace(/\s+/g, ' ').trim();
        const selectionText = editorElement('selection-text');
        if (selectionText) {
            selectionText.textContent = preview.length > 70 ? `${preview.slice(0, 70)}…` : preview;
        }
        setEditorMessage(`已选择 ${result.end - result.start} 个字符，可分配给当前阶段或常驻提示。`, 'info');
        updateStageEditorControls();
    }

    function selectMarkedRangeFromEvent(event) {
        const span = event.target && event.target.closest
            ? event.target.closest('.dga-text-mark')
            : null;
        if (!span) return;
        const ownerId = span.dataset.ownerId;
        const start = Number(span.dataset.start);
        const end = Number(span.dataset.end);
        if (!ownerId || !Number.isFinite(start) || !Number.isFinite(end)) return;
        stageEditorState.activeOwnerId = ownerId;
        stageEditorState.pendingRange = null;
        stageEditorState.selectedMarkedRange = { ownerId, start, end };
        renderStageEditorSidebar();
        renderStageEditorSettings();
        renderStageEditorText();
        setEditorMessage(`已选中“${ownerName(ownerId)}”的一处标记，可点击“清除所选标记”。`, 'info');
        updateStageEditorControls();
    }

    function assignPendingRange(ownerId) {
        const range = stageEditorState.pendingRange;
        if (!range || range.end <= range.start) {
            setEditorMessage('请先在右侧提示词原文中拖选文字。', 'warning');
            return;
        }
        if (ownerId !== 'always' && !stageEditorState.stages.some(stage => stage.id === ownerId)) {
            setEditorMessage('请先新建或选择一个剧情阶段。', 'warning');
            return;
        }
        assignRangeToOwner(ownerId, range.start, range.end);
        stageEditorState.activeOwnerId = ownerId;
        stageEditorState.pendingRange = null;
        stageEditorState.selectedMarkedRange = null;
        clearNativeSelection();
        markStageEditorDirty();
        renderStageEditorSidebar();
        renderStageEditorSettings();
        renderStageEditorText();
        setEditorMessage(`已把选中文字分配给“${ownerName(ownerId)}”。`, 'success');
        updateStageEditorControls();
    }

    function clearSelectedEditorRange() {
        const range = stageEditorState.pendingRange || stageEditorState.selectedMarkedRange;
        if (!range) {
            setEditorMessage('请先拖选文字，或点击一处已有的彩色标记。', 'warning');
            return;
        }
        clearRangeFromAllOwners(range.start, range.end);
        stageEditorState.pendingRange = null;
        stageEditorState.selectedMarkedRange = null;
        clearNativeSelection();
        markStageEditorDirty();
        renderStageEditorSidebar();
        renderStageEditorText();
        setEditorMessage('所选范围已恢复为未分配。', 'success');
        updateStageEditorControls();
    }

    function updateStageEditorControls() {
        if (stageEditorState.busy) return;
        const hasPending = Boolean(stageEditorState.pendingRange);
        const hasMarked = Boolean(stageEditorState.selectedMarkedRange);
        const hasActive = stageEditorState.activeOwnerId === 'always' || Boolean(activeStage());
        const assignButton = editorElement('assign');
        const assignAlwaysButton = editorElement('assign-always');
        const clearButton = editorElement('clear-range');
        if (assignButton) {
            assignButton.disabled = !hasPending || !hasActive;
            assignButton.textContent = stageEditorState.activeOwnerId === 'always'
                ? '分配给常驻提示'
                : `分配给${activeStage() ? `“${activeStage().name || '未命名阶段'}”` : '当前阶段'}`;
        }
        if (assignAlwaysButton) assignAlwaysButton.disabled = !hasPending;
        if (clearButton) clearButton.disabled = !hasPending && !hasMarked;
        const selectionText = editorElement('selection-text');
        if (selectionText && !hasPending) selectionText.textContent = '尚未选择文字';
    }

    function buildRangeLayoutFromEditor() {
        if (stageEditorState.stages.length === 0) {
            throw new Error('请至少新建一个剧情阶段');
        }
        const emptyStages = stageEditorState.stages.filter(stage => stage.ranges.length === 0);
        if (emptyStages.length > 0) {
            throw new Error(`这些阶段还没有选择提示词：${emptyStages.map(stage => stage.name).join('、')}`);
        }
        const text = stageEditorState.text;
        return {
            version: LAYOUT_VERSION,
            mode: 'ranges',
            sourceHash: hashText(text),
            stages: stageEditorState.stages.map((stage, index) => ({
                id: stage.id || makeStageId(),
                name: String(stage.name || `阶段 ${index + 1}`).trim() || `阶段 ${index + 1}`,
                color: normalizeColor(stage.color, DEFAULT_STAGE_COLORS[index % DEFAULT_STAGE_COLORS.length]),
                completion: String(stage.completion || '').trim(),
                ranges: normalizedIntervals(stage.ranges).map(range => (
                    createAnchoredRange(text, range.start, range.end)
                )),
            })),
            always: {
                color: normalizeColor(stageEditorState.alwaysColor, '#64748b'),
                ranges: normalizedIntervals(stageEditorState.alwaysRanges).map(range => (
                    createAnchoredRange(text, range.start, range.end)
                )),
            },
            updatedAt: new Date().toISOString(),
        };
    }

    function loadEntryIntoStageEditor(worldbookName, entry) {
        const text = normalizeText(entry && entry.content);
        const layout = getRangeLayout(entry);
        stageEditorState.worldbookName = worldbookName;
        stageEditorState.entry = entry;
        stageEditorState.text = text;
        stageEditorState.pendingRange = null;
        stageEditorState.selectedMarkedRange = null;
        stageEditorState.unresolvedCount = 0;
        stageEditorState.dirty = false;

        if (layout) {
            const resolved = resolveRangeLayout(text, layout);
            stageEditorState.stages = resolved.stages.map(stage => ({
                id: stage.id,
                name: stage.name,
                color: stage.color,
                completion: stage.completion,
                ranges: normalizedIntervals(stage.ranges),
            }));
            stageEditorState.alwaysColor = resolved.always.color;
            stageEditorState.alwaysRanges = normalizedIntervals(resolved.always.ranges);
            stageEditorState.unresolvedCount = resolved.stages.reduce(
                (sum, stage) => sum + stage.unresolvedCount,
                resolved.always.unresolvedCount,
            );
        } else {
            const firstStage = {
                id: makeStageId(),
                name: '阶段 1',
                color: DEFAULT_STAGE_COLORS[0],
                completion: '',
                ranges: [],
            };
            stageEditorState.stages = [firstStage];
            stageEditorState.alwaysColor = '#64748b';
            stageEditorState.alwaysRanges = [];
        }
        stageEditorState.activeOwnerId = stageEditorState.stages[0]
            ? stageEditorState.stages[0].id
            : 'always';
        const dirty = editorElement('dirty');
        if (dirty) dirty.hidden = true;
        const sourceName = editorElement('source-name');
        if (sourceName) sourceName.textContent = `[${worldbookName}] ${entryName(entry)}`;
        renderStageEditorSidebar();
        renderStageEditorSettings();
        renderStageEditorText();
        updateStageEditorControls();
        if (stageEditorState.unresolvedCount > 0) {
            setEditorMessage(
                `有 ${stageEditorState.unresolvedCount} 个旧选区无法在当前原文中定位。请重新选择对应文字后再保存。`,
                'warning',
            );
        } else if (layout) {
            setEditorMessage('阶段划分已载入。拖选原文，可以继续调整。', 'info');
        } else {
            setEditorMessage('拖选右侧提示词，然后把文字分配给“阶段 1”或常驻提示。', 'info');
        }
    }

    async function saveStageEditorLayout(bindAfterSave) {
        if (!stageEditorState.entry) throw new Error('没有正在编辑的世界书条目');
        const layout = buildRangeLayoutFromEditor();
        setEditorBusy(true);
        setEditorMessage('正在把阶段划分保存到世界书隐藏数据……', 'info');
        try {
            const savedEntry = await writeRangeLayout(
                stageEditorState.worldbookName,
                stageEditorState.entry,
                layout,
            );
            stageEditorState.entry = savedEntry;
            stageEditorState.dirty = false;
            stageEditorState.unresolvedCount = 0;
            const dirty = editorElement('dirty');
            if (dirty) dirty.hidden = true;
            if (bindAfterSave) {
                await bindGuideEntry(stageEditorState.worldbookName, savedEntry, { confirm: false });
            }
            await refreshManager({
                worldbookName: stageEditorState.worldbookName,
                quiet: true,
            });
            setEditorMessage(
                bindAfterSave
                    ? '阶段划分已保存并绑定，当前聊天已从第一阶段开始。'
                    : '阶段划分已保存。世界书正文没有被修改。',
                'success',
            );
        } finally {
            setEditorBusy(false);
        }
    }

    function closeStageEditor(force) {
        if (!force && stageEditorState.dirty) {
            const accepted = hostWindow.confirm('阶段划分还有未保存的修改，仍然关闭吗？');
            if (!accepted) return;
        }
        const documentRef = getHostDocument();
        const editor = documentRef && documentRef.getElementById(EDITOR_ID);
        if (editor) editor.hidden = true;
        const panel = managerElement('panel');
        if (panel) panel.hidden = false;
    }

    async function openStageEditor() {
        const entry = managerState.entryMap.get(managerState.selectedEntryKey);
        if (!managerState.selectedWorldbook || !entry) {
            throw new Error('请先在管理页选择一个世界书条目');
        }
        const worldbook = await getWorldbook(managerState.selectedWorldbook);
        const freshEntry = findEntry(worldbook, entry.uid, entryName(entry));
        if (!freshEntry) throw new Error('所选世界书条目已经不存在，请刷新后重试');
        const editor = installStageEditorUi(false);
        if (!editor) throw new Error('阶段标注器尚未准备好，请稍后重试');
        const panel = managerElement('panel');
        if (panel) panel.hidden = true;
        editor.hidden = false;
        loadEntryIntoStageEditor(managerState.selectedWorldbook, freshEntry);
        const surface = editorElement('surface');
        if (surface) surface.focus();
    }

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
            ['refresh', 'bind', 'edit-stages', 'previous', 'next', 'reset', 'worldbook-select', 'entry-select']
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
        const parsed = parseGuideEntry(entry);
        const stateLabel = entryIsDisabled(entry) ? ' · 已禁用' : '';
        if (parsed.mainBlocks.length === 0) {
            return `${entryName(entry)}（尚未划分阶段${stateLabel}）`;
        }
        if (parsed.format === 'dynamic-guide-ranges-v1') {
            return `${entryName(entry)}（可视化 ${parsed.mainBlocks.length} 个阶段${stateLabel}）`;
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
        const editStagesButton = managerElement('edit-stages');
        const previousButton = managerElement('previous');
        const nextButton = managerElement('next');
        const resetButton = managerElement('reset');
        if (refreshButton) refreshButton.disabled = false;
        if (worldbookSelect) worldbookSelect.disabled = !managerState.binding || managerState.binding.names.length === 0;
        if (entrySelect) entrySelect.disabled = managerState.entries.length === 0;
        if (bindButton) bindButton.disabled = !managerState.entryMap.has(managerState.selectedEntryKey);
        if (editStagesButton) editStagesButton.disabled = !managerState.entryMap.has(managerState.selectedEntryKey);
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

    async function bindGuideEntry(worldbookName, selectedEntry, options) {
        const settings = options || {};
        if (!worldbookName || !selectedEntry) throw new Error('请先选择世界书和指导条目');
        const worldbook = await getWorldbook(worldbookName);
        const freshEntry = findEntry(worldbook, selectedEntry.uid, entryName(selectedEntry));
        if (!freshEntry) throw new Error('所选条目已经不存在，请刷新后重试');
        const parsed = parseGuideEntry(freshEntry);
        if (parsed.mainBlocks.length === 0) {
            throw new Error(parsed.warnings.join('\n') || '所选条目没有可用的主线内容');
        }

        if (settings.confirm !== false) {
            const accepted = hostWindow.confirm(
                `绑定“${entryName(freshEntry)}”作为动态指导页？\n\n`
                + `剧情阶段：${parsed.mainBlocks.length} 段\n`
                + `常驻或附加内容：${parsed.addonBlocks.length} 段\n\n`
                + '绑定后会禁用这个世界书原条目，避免完整大纲被直接发送给 AI。',
            );
            if (!accepted) return false;
        }

        await disableSourceEntry(worldbookName, freshEntry.uid, entryName(freshEntry));
        freshEntry.enabled = false;
        if ('disable' in freshEntry) freshEntry.disable = true;
        const config = {
            format: parsed.format,
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
        const documentRef = getHostDocument();
        const editor = documentRef && documentRef.getElementById(EDITOR_ID);
        if (editor) editor.hidden = true;
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
#${EDITOR_ID} {
    position: fixed;
    inset: 0;
    z-index: 100001;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(8, 10, 16, 0.76);
    backdrop-filter: blur(6px);
    color: var(--SmartThemeBodyColor, #ececf1);
}
#${EDITOR_ID}[hidden] { display: none !important; }
#${EDITOR_ID} * { box-sizing: border-box; }
#${EDITOR_ID} .dga-editor-shell {
    width: min(1180px, 100%);
    height: min(92vh, 940px);
    min-height: 560px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 22%, transparent);
    border-radius: 16px;
    background: var(--SmartThemeBlurTintColor, rgba(28, 30, 38, 0.99));
    box-shadow: 0 24px 76px rgba(0, 0, 0, 0.5);
}
#${EDITOR_ID} .dga-editor-header,
#${EDITOR_ID} .dga-editor-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 14%, transparent);
}
#${EDITOR_ID} .dga-editor-footer {
    justify-content: flex-end;
    border-top: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 14%, transparent);
    border-bottom: 0;
}
#${EDITOR_ID} .dga-editor-title { margin: 0; font-size: 1.12rem; }
#${EDITOR_ID} .dga-editor-source {
    margin: 4px 0 0;
    max-width: min(70vw, 760px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.7;
    font-size: 0.82rem;
}
#${EDITOR_ID} .dga-editor-dirty {
    margin-left: 7px;
    color: #f6c453;
    font-size: 0.78rem;
}
#${EDITOR_ID} .dga-editor-main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(245px, 290px) minmax(0, 1fr);
}
#${EDITOR_ID} .dga-editor-sidebar {
    min-width: 0;
    overflow-y: auto;
    padding: 14px;
    border-right: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 14%, transparent);
    background: rgba(0, 0, 0, 0.08);
}
#${EDITOR_ID} .dga-editor-workspace {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
}
#${EDITOR_ID} .dga-editor-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 9px;
}
#${EDITOR_ID} h3 { margin: 0; font-size: 0.96rem; }
#${EDITOR_ID} .dga-editor-help {
    margin: 7px 0 10px;
    opacity: 0.72;
    font-size: 0.8rem;
    line-height: 1.5;
}
#${EDITOR_ID} .dga-stage-list { display: grid; gap: 7px; }
#${EDITOR_ID} .dga-stage-item {
    width: 100%;
    display: grid;
    gap: 4px;
    padding: 10px 11px 10px 14px;
    border: 1px solid color-mix(in srgb, var(--dga-stage-color) 46%, transparent);
    border-radius: 10px;
    color: inherit;
    background: color-mix(in srgb, var(--dga-stage-color) 10%, transparent);
    box-shadow: inset 4px 0 0 var(--dga-stage-color);
    text-align: left;
    cursor: pointer;
}
#${EDITOR_ID} .dga-stage-item.is-active {
    border-color: var(--dga-stage-color);
    background: color-mix(in srgb, var(--dga-stage-color) 23%, transparent);
}
#${EDITOR_ID} .dga-stage-item strong { overflow-wrap: anywhere; }
#${EDITOR_ID} .dga-stage-item span { opacity: 0.68; font-size: 0.76rem; }
#${EDITOR_ID} .dga-editor-settings {
    display: grid;
    gap: 10px;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 13%, transparent);
}
#${EDITOR_ID} label { display: grid; gap: 6px; font-size: 0.8rem; opacity: 0.9; }
#${EDITOR_ID} input[type="text"],
#${EDITOR_ID} textarea {
    width: 100%;
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 18%, transparent);
    border-radius: 8px;
    padding: 8px 9px;
    color: inherit;
    background: var(--SmartThemeBotMesBlurTintColor, rgba(20, 22, 28, 0.85));
    font: inherit;
}
#${EDITOR_ID} textarea { min-height: 76px; resize: vertical; line-height: 1.45; }
#${EDITOR_ID} input[type="color"] {
    width: 100%;
    height: 38px;
    padding: 3px;
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 18%, transparent);
    border-radius: 8px;
    background: transparent;
    cursor: pointer;
}
#${EDITOR_ID} .dga-editor-actions,
#${EDITOR_ID} .dga-selection-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
}
#${EDITOR_ID} .dga-button {
    min-height: 38px;
    padding: 8px 12px;
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 18%, transparent);
    border-radius: 8px;
    color: inherit;
    background: var(--SmartThemeBotMesBlurTintColor, rgba(20, 22, 28, 0.85));
    cursor: pointer;
    font-weight: 620;
}
#${EDITOR_ID} .dga-button.dga-primary {
    border-color: transparent;
    color: #fff;
    background: var(--SmartThemeQuoteColor, #7b62d9);
}
#${EDITOR_ID} .dga-button.dga-danger { color: #ff9ba3; }
#${EDITOR_ID} .dga-close {
    min-width: 38px;
    min-height: 38px;
    border: 0;
    border-radius: 10px;
    color: inherit;
    background: rgba(255, 255, 255, 0.08);
    cursor: pointer;
    font-size: 1.35rem;
}
#${EDITOR_ID} button:disabled { opacity: 0.44; cursor: not-allowed; }
#${EDITOR_ID} .dga-selection-bar {
    display: grid;
    gap: 8px;
    padding: 10px 11px;
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 13%, transparent);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.045);
}
#${EDITOR_ID} .dga-selection-preview {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.82rem;
    opacity: 0.78;
}
#${EDITOR_ID} .dga-text-surface {
    flex: 1;
    min-height: 260px;
    overflow: auto;
    padding: 18px;
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 16%, transparent);
    border-radius: 12px;
    outline: none;
    background: rgba(0, 0, 0, 0.19);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    cursor: text;
    font-family: inherit;
    font-size: 0.94rem;
    line-height: 1.75;
}
#${EDITOR_ID} .dga-text-surface:focus {
    border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #7b62d9) 72%, transparent);
}
#${EDITOR_ID} .dga-text-mark {
    padding: 1px 0;
    border-bottom: 2px solid var(--dga-mark-color);
    border-radius: 3px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    cursor: pointer;
}
#${EDITOR_ID} .dga-text-mark.is-active { box-shadow: 0 0 0 1px var(--dga-mark-color); }
#${EDITOR_ID} .dga-text-mark.is-selected { outline: 2px solid #fff; outline-offset: 2px; }
#${EDITOR_ID} .dga-editor-message {
    padding: 9px 11px;
    border-radius: 9px;
    font-size: 0.82rem;
    line-height: 1.45;
}
#${EDITOR_ID} .dga-editor-message[data-type="info"] { background: rgba(80, 140, 220, 0.15); }
#${EDITOR_ID} .dga-editor-message[data-type="success"] { background: rgba(70, 180, 115, 0.16); }
#${EDITOR_ID} .dga-editor-message[data-type="warning"] { background: rgba(230, 165, 60, 0.16); }
#${EDITOR_ID} .dga-editor-message[data-type="error"] { background: rgba(220, 75, 85, 0.17); }
#${EDITOR_ID}.dga-busy .dga-editor-shell { cursor: progress; }
@media (max-width: 680px) {
    #${PANEL_ID} { padding: 0; align-items: stretch; }
    #${PANEL_ID} .dga-shell { width: 100%; max-height: 100vh; min-height: 100vh; border-radius: 0; }
    #${PANEL_ID} .dga-summary, #${PANEL_ID} .dga-fields, #${PANEL_ID} .dga-meta { grid-template-columns: 1fr; }
    #${PANEL_ID} .dga-actions { flex-wrap: wrap; }
    #${PANEL_ID} .dga-actions .dga-button { flex: 1 1 42%; }
    #${EDITOR_ID} { padding: 0; align-items: stretch; }
    #${EDITOR_ID} .dga-editor-shell { width: 100%; height: 100vh; min-height: 100vh; border-radius: 0; }
    #${EDITOR_ID} .dga-editor-main { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
    #${EDITOR_ID} .dga-editor-sidebar {
        max-height: 42vh;
        border-right: 0;
        border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 14%, transparent);
    }
    #${EDITOR_ID} .dga-editor-workspace { padding: 10px; }
    #${EDITOR_ID} .dga-editor-footer { flex-wrap: wrap; padding: 10px; }
    #${EDITOR_ID} .dga-editor-footer .dga-button { flex: 1 1 42%; }
    #${EDITOR_ID} .dga-selection-actions .dga-button { flex: 1 1 45%; }
    #${EDITOR_ID} .dga-text-surface { padding: 13px; font-size: 0.9rem; }
}`;
    }

    function runStageEditorAction(label, action) {
        Promise.resolve()
            .then(action)
            .catch(error => {
                console.error(`[${SCRIPT_NAME}] ${label}失败`, error);
                setEditorMessage(error.message || String(error), 'error');
                notify(error.message || String(error), 'error');
            });
    }

    function installStageEditorUi(force) {
        const documentRef = getHostDocument();
        if (!documentRef || !documentRef.body) return null;
        if (force) {
            const oldEditor = documentRef.getElementById(EDITOR_ID);
            if (oldEditor) oldEditor.remove();
        }
        const existing = documentRef.getElementById(EDITOR_ID);
        if (existing) return existing;

        const editor = documentRef.createElement('div');
        editor.id = EDITOR_ID;
        editor.hidden = true;
        editor.setAttribute('role', 'dialog');
        editor.setAttribute('aria-modal', 'true');
        editor.setAttribute('aria-labelledby', `${UI_PREFIX}-editor-title`);
        editor.innerHTML = `
<div class="dga-editor-shell" tabindex="-1">
    <header class="dga-editor-header">
        <div>
            <h2 class="dga-editor-title" id="${UI_PREFIX}-editor-title">划分提示词阶段</h2>
            <p class="dga-editor-source"><span id="${UI_PREFIX}-editor-source-name">尚未选择条目</span><span class="dga-editor-dirty" id="${UI_PREFIX}-editor-dirty" hidden>● 未保存</span></p>
        </div>
        <button class="dga-close" id="${UI_PREFIX}-editor-close" type="button" aria-label="返回管理页">×</button>
    </header>
    <div class="dga-editor-main">
        <aside class="dga-editor-sidebar">
            <div class="dga-editor-section-head">
                <h3>剧情阶段</h3>
                <button class="dga-button" id="${UI_PREFIX}-editor-new-stage" type="button">＋ 新建</button>
            </div>
            <p class="dga-editor-help">每个颜色是一段故事指导。可让同一阶段包含多处不连续文字；“常驻提示”会在全部阶段发送。</p>
            <div class="dga-stage-list" id="${UI_PREFIX}-editor-stage-list"></div>

            <div class="dga-editor-settings">
                <h3 id="${UI_PREFIX}-editor-settings-title">阶段设置</h3>
                <label id="${UI_PREFIX}-editor-stage-name-wrap">阶段名称
                    <input id="${UI_PREFIX}-editor-stage-name" type="text" maxlength="80" placeholder="例如：雨夜初遇">
                </label>
                <label>标记颜色
                    <input id="${UI_PREFIX}-editor-stage-color" type="color" value="#8b5cf6">
                </label>
                <label id="${UI_PREFIX}-editor-completion-wrap">什么时候进入下一阶段
                    <textarea id="${UI_PREFIX}-editor-stage-completion" placeholder="例如：两人完成第一次正式交谈。留空时也可以手动点“下一段”。"></textarea>
                </label>
                <div class="dga-editor-actions" id="${UI_PREFIX}-editor-order-actions">
                    <button class="dga-button" id="${UI_PREFIX}-editor-move-up" type="button">上移</button>
                    <button class="dga-button" id="${UI_PREFIX}-editor-move-down" type="button">下移</button>
                </div>
                <button class="dga-button dga-danger" id="${UI_PREFIX}-editor-delete-stage" type="button">删除这个阶段</button>
            </div>
        </aside>

        <section class="dga-editor-workspace">
            <div>
                <h3>世界书提示词原文</h3>
                <p class="dga-editor-help">像涂色一样拖选文字，再分配给左侧阶段。这里只决定哪些提示词在何时发送，世界书正文不会被改写。</p>
            </div>
            <div class="dga-selection-bar">
                <div class="dga-selection-preview"><b>当前选择：</b><span id="${UI_PREFIX}-editor-selection-text">尚未选择文字</span></div>
                <div class="dga-selection-actions">
                    <button class="dga-button dga-primary" id="${UI_PREFIX}-editor-assign" type="button" disabled>分配给当前阶段</button>
                    <button class="dga-button" id="${UI_PREFIX}-editor-assign-always" type="button" disabled>设为常驻提示</button>
                    <button class="dga-button" id="${UI_PREFIX}-editor-clear-range" type="button" disabled>清除所选标记</button>
                </div>
            </div>
            <div class="dga-text-surface" id="${UI_PREFIX}-editor-surface" tabindex="0" aria-label="可拖选的世界书提示词原文"></div>
            <div class="dga-editor-message" id="${UI_PREFIX}-editor-message" data-type="info" hidden></div>
        </section>
    </div>
    <footer class="dga-editor-footer">
        <button class="dga-button" id="${UI_PREFIX}-editor-save" type="button">保存划分</button>
        <button class="dga-button dga-primary" id="${UI_PREFIX}-editor-save-bind" type="button">保存并绑定</button>
    </footer>
</div>`;
        documentRef.body.appendChild(editor);

        editorElement('close').onclick = () => closeStageEditor(false);
        editor.onclick = event => {
            if (event.target === editor) closeStageEditor(false);
        };
        editor.onkeydown = event => {
            if (event.key === 'Escape') closeStageEditor(false);
        };

        editorElement('new-stage').onclick = addStage;
        editorElement('move-up').onclick = () => moveActiveStage(-1);
        editorElement('move-down').onclick = () => moveActiveStage(1);
        editorElement('delete-stage').onclick = deleteActiveStage;
        editorElement('assign').onclick = () => assignPendingRange(stageEditorState.activeOwnerId);
        editorElement('assign-always').onclick = () => assignPendingRange('always');
        editorElement('clear-range').onclick = clearSelectedEditorRange;
        editorElement('save').onclick = () => runStageEditorAction(
            '保存阶段划分',
            () => saveStageEditorLayout(false),
        );
        editorElement('save-bind').onclick = () => runStageEditorAction(
            '保存并绑定阶段划分',
            () => saveStageEditorLayout(true),
        );

        const nameInput = editorElement('stage-name');
        nameInput.oninput = event => {
            const stage = activeStage();
            if (!stage) return;
            stage.name = event.target.value;
            markStageEditorDirty();
            renderStageEditorSidebar();
            const title = editorElement('settings-title');
            if (title) title.textContent = `${stage.name || '未命名阶段'}设置`;
            updateStageEditorControls();
        };
        nameInput.onblur = event => {
            const stage = activeStage();
            if (!stage || String(event.target.value || '').trim()) return;
            const index = stageEditorState.stages.findIndex(item => item.id === stage.id);
            stage.name = `阶段 ${index + 1}`;
            event.target.value = stage.name;
            renderStageEditorSidebar();
            renderStageEditorSettings();
            updateStageEditorControls();
        };
        editorElement('stage-completion').oninput = event => {
            const stage = activeStage();
            if (!stage) return;
            stage.completion = event.target.value;
            markStageEditorDirty();
        };
        editorElement('stage-color').oninput = event => {
            const color = normalizeColor(event.target.value, '#64748b');
            if (stageEditorState.activeOwnerId === 'always') {
                stageEditorState.alwaysColor = color;
            } else {
                const stage = activeStage();
                if (!stage) return;
                stage.color = color;
            }
            markStageEditorDirty();
            renderStageEditorSidebar();
            renderStageEditorText();
        };

        const surface = editorElement('surface');
        const captureSoon = () => hostWindow.setTimeout(captureStageEditorSelection, 0);
        surface.addEventListener('mouseup', captureStageEditorSelection);
        surface.addEventListener('keyup', captureStageEditorSelection);
        surface.addEventListener('touchend', captureSoon, { passive: true });
        surface.addEventListener('click', event => {
            if (selectionOffsetsInSurface()) {
                captureStageEditorSelection();
                return;
            }
            selectMarkedRangeFromEvent(event);
        });
        updateStageEditorControls();
        return editor;
    }

    function installManagerUi(force) {
        const documentRef = getHostDocument();
        if (!documentRef || !documentRef.body) return null;
        if (force) {
            const oldPanel = documentRef.getElementById(PANEL_ID);
            const oldEditor = documentRef.getElementById(EDITOR_ID);
            const oldStyle = documentRef.getElementById(STYLE_ID);
            if (oldPanel) oldPanel.remove();
            if (oldEditor) oldEditor.remove();
            if (oldStyle) oldStyle.remove();
        }
        const existing = documentRef.getElementById(PANEL_ID);
        if (existing) {
            installStageEditorUi(false);
            return existing;
        }

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
                <button class="dga-button dga-primary" id="${UI_PREFIX}-edit-stages" type="button">划分提示词阶段</button>
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
        installStageEditorUi(false);

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
        managerElement('edit-stages').onclick = () => {
            setManagerBusy(true);
            setManagerMessage('正在打开提示词阶段标注器……', 'info');
            Promise.resolve()
                .then(openStageEditor)
                .catch(error => {
                    console.error(`[${SCRIPT_NAME}] 打开阶段标注器失败`, error);
                    setManagerMessage(error.message || String(error), 'error');
                    notify(error.message || String(error), 'error');
                })
                .finally(() => setManagerBusy(false));
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
        const documentRef = getHostDocument();
        const editor = documentRef && documentRef.getElementById(EDITOR_ID);
        if (editor) editor.hidden = true;
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
        parseGuideEntry,
        getRangeLayout,
        resolveRangeLayout,
        createAnchoredRange,
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
