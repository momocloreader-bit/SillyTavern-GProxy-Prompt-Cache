import { eventSource, event_types, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { isTrueBoolean } from '../../utils.js';

const MODULE_NAME = 'gproxy-prompt-cache';
const SETTINGS_KEY = 'gproxyPromptCache';

const MAGIC_TRIGGERS = Object.freeze({
    auto: 'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_7D9ASD7A98SD7A9S8D79ASC98A7FNKJBVV80SCMSHDSIUCH',
    '5m': 'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_49VA1S5V19GR4G89W2V695G9W9GV52W95V198WV5W2FC9DF',
    '1h': 'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_1FAS5GV9R5H29T5Y2J9584K6O95M2NBVW52C95CX984FRJY',
});

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    trigger: '1h',
    summaryTitle: '摘要',
});

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    }

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[SETTINGS_KEY][key] === undefined) {
            extension_settings[SETTINGS_KEY][key] = value;
        }
    }

    const trigger = String(extension_settings[SETTINGS_KEY].trigger);
    if (!Object.prototype.hasOwnProperty.call(MAGIC_TRIGGERS, trigger)) {
        extension_settings[SETTINGS_KEY].trigger = DEFAULT_SETTINGS.trigger;
    }

    const summaryTitle = String(extension_settings[SETTINGS_KEY].summaryTitle || '').trim();
    extension_settings[SETTINGS_KEY].summaryTitle = summaryTitle || DEFAULT_SETTINGS.summaryTitle;

    return extension_settings[SETTINGS_KEY];
}

function saveSettings() {
    saveSettingsDebounced();
    updateStatus();
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createSummaryBlockRegex(summaryTitle) {
    const title = escapeRegex(summaryTitle.trim() || DEFAULT_SETTINGS.summaryTitle);
    return new RegExp(`<details\\b[^>]*>\\s*<summary\\b[^>]*>\\s*${title}\\s*<\\/summary>[\\s\\S]*?<\\/details>\\s*`, 'i');
}

function stripMagicTriggers(text) {
    let nextText = String(text ?? '');
    for (const trigger of Object.values(MAGIC_TRIGGERS)) {
        nextText = nextText.split(trigger).join('');
    }
    return nextText;
}

function appendMagicTrigger(text, trigger) {
    const cleanText = stripMagicTriggers(text);
    return `${cleanText}${trigger}`;
}

function splitManagedMessage(text, summaryPattern) {
    const match = summaryPattern.exec(String(text ?? ''));
    if (!match) {
        return null;
    }

    const summary = match[0];
    const body = String(text).slice(0, match.index) + String(text).slice(match.index + summary.length);

    return {
        summary,
        body,
    };
}

function findManagedTextTarget(message, summaryPattern) {
    if (!message || message.role !== 'assistant' || message.tool_calls) {
        return null;
    }

    if (typeof message.content === 'string') {
        const parts = splitManagedMessage(message.content, summaryPattern);
        if (!parts) {
            return null;
        }

        return {
            parts,
            setText(value) {
                message.content = value;
            },
        };
    }

    if (Array.isArray(message.content)) {
        for (let i = 0; i < message.content.length; i++) {
            const block = message.content[i];

            if (typeof block === 'string') {
                const parts = splitManagedMessage(block, summaryPattern);
                if (!parts) {
                    continue;
                }

                return {
                    parts,
                    setText(value) {
                        message.content[i] = value;
                    },
                };
            }

            if (block && typeof block === 'object' && typeof block.text === 'string') {
                const parts = splitManagedMessage(block.text, summaryPattern);
                if (!parts) {
                    continue;
                }

                return {
                    parts,
                    setText(value) {
                        block.text = value;
                    },
                };
            }
        }
    }

    if (message.content && typeof message.content === 'object' && typeof message.content.text === 'string') {
        const parts = splitManagedMessage(message.content.text, summaryPattern);
        if (!parts) {
            return null;
        }

        return {
            parts,
            setText(value) {
                message.content.text = value;
            },
        };
    }

    return null;
}

function computeBoundary(totalManagedMessages) {
    if (totalManagedMessages < 20) {
        return 0;
    }

    return Math.floor(totalManagedMessages / 10) * 10 - 10;
}

function analyzeChatMessages(messages, summaryTitle) {
    const summaryPattern = createSummaryBlockRegex(summaryTitle);
    let totalManagedMessages = 0;

    for (const message of messages) {
        if (!message || message.is_system || message.is_user || typeof message.mes !== 'string') {
            continue;
        }

        if (summaryPattern.test(message.mes)) {
            totalManagedMessages += 1;
        }
    }

    const boundary = computeBoundary(totalManagedMessages);
    const bodyStart = boundary + 1;

    return {
        totalManagedMessages,
        boundary,
        summaryCount: boundary,
        bodyCount: Math.max(totalManagedMessages - boundary, 0),
        bodyRange: totalManagedMessages > 0 ? `${bodyStart}-${totalManagedMessages}` : '0-0',
    };
}

function buildStatusText(stats) {
    if (!stats.totalManagedMessages) {
        return 'No managed assistant messages in the current chat.';
    }

    if (!stats.boundary) {
        return `Managed assistant messages: ${stats.totalManagedMessages}. Summary-only: 0. Body-only: ${stats.totalManagedMessages} (1-${stats.totalManagedMessages}).`;
    }

    return `Managed assistant messages: ${stats.totalManagedMessages}. Summary-only: ${stats.summaryCount} (1-${stats.boundary}). Body-only: ${stats.bodyCount} (${stats.bodyRange}).`;
}

function updateStatus() {
    const statusElement = $('#gproxy_prompt_cache_status');
    if (!statusElement.length) {
        return;
    }

    const settings = getSettings();
    const context = getContext();
    const stats = analyzeChatMessages(context.chat ?? [], settings.summaryTitle);
    const enabledLabel = settings.enabled ? 'enabled' : 'disabled';
    const triggerLabel = settings.trigger;
    statusElement.text(`[${enabledLabel}] ${buildStatusText(stats)} Trigger: ${triggerLabel}.`);
}

function syncSettingsUi() {
    const settings = getSettings();
    $('#gproxy_prompt_cache_enabled').prop('checked', !!settings.enabled);
    $('#gproxy_prompt_cache_trigger').val(settings.trigger);
    $('#gproxy_prompt_cache_summary_title').val(settings.summaryTitle);
    updateStatus();
}

function restoreDefaults() {
    extension_settings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    syncSettingsUi();
    saveSettings();
}

function applyPromptRewrite(eventData) {
    const settings = getSettings();
    if (!settings.enabled || !Array.isArray(eventData?.chat) || eventData.dryRun === true) {
        return;
    }

    const summaryPattern = createSummaryBlockRegex(settings.summaryTitle);
    const trigger = MAGIC_TRIGGERS[settings.trigger] || MAGIC_TRIGGERS[DEFAULT_SETTINGS.trigger];
    const managedMessages = [];

    for (let index = 0; index < eventData.chat.length; index++) {
        const message = eventData.chat[index];
        const target = findManagedTextTarget(message, summaryPattern);
        if (!target) {
            continue;
        }

        managedMessages.push({
            index,
            target,
        });
    }

    const boundary = computeBoundary(managedMessages.length);
    const removeIndices = [];

    managedMessages.forEach((entry, offset) => {
        const position = offset + 1;
        const isSummaryOnly = boundary > 0 && position <= boundary;
        const isBoundaryMessage = boundary > 0 && position === boundary;
        const isLastManagedMessage = position === managedMessages.length;

        let nextText = isSummaryOnly ? entry.target.parts.summary : entry.target.parts.body;
        nextText = stripMagicTriggers(nextText);

        if (isBoundaryMessage || isLastManagedMessage) {
            nextText = appendMagicTrigger(nextText, trigger);
        }

        if (!nextText.trim()) {
            removeIndices.push(entry.index);
            return;
        }

        entry.target.setText(nextText);
    });

    removeIndices.sort((a, b) => b - a);
    for (const index of removeIndices) {
        eventData.chat.splice(index, 1);
    }
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'gproxycache-status',
        callback: () => {
            const settings = getSettings();
            const stats = analyzeChatMessages(getContext().chat ?? [], settings.summaryTitle);
            return `[${settings.enabled ? 'enabled' : 'disabled'}] ${buildStatusText(stats)} Trigger: ${settings.trigger}.`;
        },
        returns: 'current gproxy prompt cache status',
        helpString: 'Show current GProxy Prompt Cache status for the active chat.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'gproxycache-set',
        callback: (args) => {
            const settings = getSettings();

            if (args.enabled !== undefined && args.enabled !== '') {
                settings.enabled = isTrueBoolean(String(args.enabled));
            }

            if (args.trigger !== undefined && args.trigger !== '') {
                const trigger = String(args.trigger);
                if (Object.prototype.hasOwnProperty.call(MAGIC_TRIGGERS, trigger)) {
                    settings.trigger = trigger;
                }
            }

            if (args.summary !== undefined && args.summary !== '') {
                const summaryTitle = String(args.summary).trim();
                if (summaryTitle) {
                    settings.summaryTitle = summaryTitle;
                }
            }

            syncSettingsUi();
            saveSettings();
            return `[${settings.enabled ? 'enabled' : 'disabled'}] trigger=${settings.trigger} summary=${settings.summaryTitle}`;
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'enabled',
                description: 'enable or disable the extension',
                typeList: [ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'trigger',
                description: 'cache trigger ttl: auto, 5m, or 1h',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
                enumList: Object.keys(MAGIC_TRIGGERS),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'summary',
                description: 'summary heading text used inside the details summary tag',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
        ],
        returns: 'updated gproxy prompt cache config',
        helpString: 'Update GProxy Prompt Cache settings. Example: /gproxycache-set enabled=true trigger=1h summary=摘要',
    }));
}

async function addSettingsUi() {
    const settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    const containerId = 'gproxy_prompt_cache_container';

    if (!document.getElementById(containerId)) {
        $('#extensions_settings2').append(`<div id="${containerId}" class="extension_container"></div>`);
    }

    $(`#${containerId}`).empty().append(settingsHtml);

    $('#gproxy_prompt_cache_enabled').on('input', () => {
        getSettings().enabled = $('#gproxy_prompt_cache_enabled').prop('checked');
        saveSettings();
    });

    $('#gproxy_prompt_cache_trigger').on('change', () => {
        getSettings().trigger = String($('#gproxy_prompt_cache_trigger').val());
        saveSettings();
    });

    $('#gproxy_prompt_cache_summary_title').on('input', () => {
        const value = String($('#gproxy_prompt_cache_summary_title').val()).trim();
        getSettings().summaryTitle = value || DEFAULT_SETTINGS.summaryTitle;
        saveSettings();
    });

    $('#gproxy_prompt_cache_refresh').on('click', updateStatus);
    $('#gproxy_prompt_cache_restore').on('click', restoreDefaults);
    syncSettingsUi();
}

jQuery(async () => {
    await addSettingsUi();
    registerSlashCommands();

    eventSource.makeLast(event_types.CHAT_COMPLETION_PROMPT_READY, applyPromptRewrite);
    eventSource.on(event_types.CHAT_CHANGED, updateStatus);
    eventSource.on(event_types.MESSAGE_SENT, updateStatus);
    eventSource.on(event_types.MESSAGE_RECEIVED, updateStatus);
    eventSource.on(event_types.MESSAGE_DELETED, updateStatus);
    eventSource.on(event_types.MESSAGE_EDITED, updateStatus);
    eventSource.on(event_types.MESSAGE_UPDATED, updateStatus);
    eventSource.on(event_types.MESSAGE_SWIPED, updateStatus);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, updateStatus);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, updateStatus);
});
