"use strict";
/**
 * Azure OpenAI-based Agent Executor
 *
 * This module provides a custom implementation of agent execution using Azure OpenAI's API directly,
 * replacing Scrapybara's act() method. It manages tool execution, streaming, and structured outputs.
 *
 * CRITICAL: OpenAI Image Handling Pattern
 * ========================================
 * OpenAI does NOT allow images in 'tool' role messages.
 * Images can ONLY appear in 'user' role messages.
 *
 * Solution implemented:
 * 1. Extract base64 images from tool results
 * 2. Add 'tool' message with text result (no image)
 * 3. Immediately add 'user' message with the image
 *
 * This replicates how Scrapybara's backend handles OpenAI models.
 *
 * @see https://learn.microsoft.com/azure/ai-services/openai/
 * @see https://platform.openai.com/docs/guides/vision
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIAgentExecutor = void 0;
var openai_1 = __importDefault(require("openai"));
var zod_1 = require("zod");
var zod_to_json_schema_1 = require("zod-to-json-schema");
/**
 * Helper function to filter base64 images in messages, keeping only the latest ones up to specified limit.
 * This prevents the context window from growing infinitely with accumulated screenshots.
 * Based on Scrapybara's implementation pattern.
 *
 * @param messages - List of messages to filter (modifies in place)
 * @param imagesToKeep - Maximum number of images to keep
 */
function filterImages(messages, imagesToKeep) {
    var imagesKept = 0;
    // Iterate backwards through messages (most recent first)
    for (var i = messages.length - 1; i >= 0; i--) {
        var msg = messages[i];
        // Check user messages with image_url content
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (var j = msg.content.length - 1; j >= 0; j--) {
                var contentPart = msg.content[j];
                if (contentPart.type === 'image_url' && contentPart.image_url) {
                    // Validate base64 or URL format before keeping
                    var imageUrl = contentPart.image_url.url;
                    if (imageUrl && (imageUrl.startsWith('data:image/') || imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
                        if (imagesKept < imagesToKeep) {
                            imagesKept++;
                        }
                        else {
                            // Remove old images by splicing from array
                            msg.content.splice(j, 1);
                        }
                    }
                    else {
                        // Remove invalid image URLs immediately
                        console.log("\uD83E\uDDF9 [IMAGE_FILTER] Removing invalid image URL: ".concat(imageUrl === null || imageUrl === void 0 ? void 0 : imageUrl.substring(0, 100), "..."));
                        msg.content.splice(j, 1);
                    }
                }
            }
            // If user message has no content left, remove the text too to clean up
            if (msg.content.length === 0) {
                messages.splice(i, 1);
            }
            else if (msg.content.length === 1 && msg.content[0].type === 'text' &&
                msg.content[0].text.includes('Here are the')) {
                // If only descriptive text left without images, remove the whole message
                messages.splice(i, 1);
            }
        }
        // Also clean any base64 data from tool messages that might be causing issues
        if (msg.role === 'tool' && typeof msg.content === 'string') {
            // Remove any base64 image data from tool messages
            if (msg.content.includes('base64') || msg.content.length > 50000) {
                console.log("\uD83E\uDDF9 [IMAGE_FILTER] Cleaning base64 data from tool message");
                msg.content = msg.content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA_REMOVED]');
            }
            // CRITICAL: Clean generateImage tool messages but keep them
            if (msg.content.includes('generateImage') || msg.content.includes('image_urls') || msg.content.includes('provider')) {
                console.log("\uD83E\uDDF9 [IMAGE_FILTER] Cleaning generateImage tool message content");
                // Remove any base64 data but keep the message
                msg.content = msg.content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA_REMOVED]');
            }
        }
    }
}
var OpenAIAgentExecutor = /** @class */ (function () {
    function OpenAIAgentExecutor(config) {
        // Support both string (legacy) and config object
        if (typeof config === 'string') {
            config = { apiKey: config };
        }
        var apiKey = (config === null || config === void 0 ? void 0 : config.apiKey) || process.env.MICROSOFT_AZURE_OPENAI_API_KEY;
        var endpoint = (config === null || config === void 0 ? void 0 : config.endpoint) || process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT;
        var deployment = (config === null || config === void 0 ? void 0 : config.deployment) || process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
        var apiVersion = (config === null || config === void 0 ? void 0 : config.apiVersion) || process.env.MICROSOFT_AZURE_OPENAI_API_VERSION || '2024-08-01-preview';
        if (!endpoint) {
            throw new Error('Azure OpenAI endpoint is required. Set MICROSOFT_AZURE_OPENAI_ENDPOINT environment variable.');
        }
        if (!apiKey) {
            throw new Error('Azure OpenAI API key is required. Set MICROSOFT_AZURE_OPENAI_API_KEY environment variable.');
        }
        // Configure OpenAI client for Azure
        this.client = new openai_1.default({
            apiKey: apiKey,
            baseURL: "".concat(endpoint, "/openai/deployments/").concat(deployment),
            defaultQuery: { 'api-version': apiVersion },
            defaultHeaders: { 'api-key': apiKey },
        });
        this.deployment = deployment;
    }
    /**
     * Extract and strip base64 images from tool results
     * Images will be sent separately as user messages (OpenAI requirement)
     */
    OpenAIAgentExecutor.prototype.extractBase64Image = function (result) {
        var base64Image = null;
        // CRITICAL: Handle generateImage tool results properly
        if (typeof result === 'object' && result !== null && result.provider && result.image_urls) {
            console.log("\uD83E\uDDF9 [IMAGE_FILTER] Processing generateImage tool result");
            return {
                cleanedResult: result, // Return the full result, not just the message
                base64Image: null
            };
        }
        if (typeof result === 'string') {
            // Check if it's a base64 image string
            if (result.includes('base64') || result.length > 10000) {
                var imageData = result.startsWith('data:image') ? result : "data:image/png;base64,".concat(result);
                return {
                    cleanedResult: 'Screenshot captured successfully.',
                    base64Image: imageData
                };
            }
            return { cleanedResult: result, base64Image: null };
        }
        if (typeof result === 'object' && result !== null) {
            var cleaned = Array.isArray(result) ? [] : {};
            for (var _i = 0, _a = Object.entries(result); _i < _a.length; _i++) {
                var _b = _a[_i], key = _b[0], value = _b[1];
                // Detect base64 image fields
                if (key === 'base64_image' || key === 'base64Image' || key === 'screenshot' || key === 'image') {
                    if (typeof value === 'string' && value.length > 1000) {
                        base64Image = value.startsWith('data:image') ? value : "data:image/png;base64,".concat(value);
                        cleaned[key] = '[Image captured - will be shown separately]';
                    }
                    else {
                        cleaned[key] = value;
                    }
                }
                else if (typeof value === 'string' && (value.startsWith('data:image') || value.startsWith('/9j/') || value.length > 10000)) {
                    // Detect base64 strings by data URI or length
                    base64Image = value.startsWith('data:image') ? value : "data:image/png;base64,".concat(value);
                    cleaned[key] = '[Image captured - will be shown separately]';
                }
                else if (typeof value === 'object' && value !== null) {
                    // Recursively process nested objects
                    var nested = this.extractBase64Image(value);
                    cleaned[key] = nested.cleanedResult;
                    if (nested.base64Image && !base64Image) {
                        base64Image = nested.base64Image;
                    }
                }
                else {
                    cleaned[key] = value;
                }
            }
            return { cleanedResult: cleaned, base64Image: base64Image };
        }
        return { cleanedResult: result, base64Image: null };
    };
    /**
     * Run streaming completion: iterate over chunks, accumulate message, call onStreamChunk.
     * Supports reasoning/thinking via delta.reasoning_content or delta.reasoning (o-series, etc).
     * Throttles DB updates to ~80ms to avoid excessive instance_log writes.
     */
    OpenAIAgentExecutor.prototype.runStreamingCompletion = function (completionOptions, callbacks, totalUsage) {
        return __awaiter(this, void 0, void 0, function () {
            var opts, stream, content, reasoningContent, toolCallsAccum, finishReason, usage, streamingLogId, thinkingLogId, STREAM_THROTTLE_MS, lastEmitTime, lastThinkingEmitTime, _a, _b, _c, chunk, choice, delta, reasoningDelta, now, now, _i, _d, tc, idx, e_1_1, u, reasoningTokens, toolCallsArray, message;
            var _e, e_1, _f, _g;
            var _h, _j, _k, _l, _m, _o, _p, _q, _r;
            return __generator(this, function (_s) {
                switch (_s.label) {
                    case 0:
                        opts = __assign(__assign({}, completionOptions), { stream: true, stream_options: { include_usage: true } });
                        return [4 /*yield*/, this.client.chat.completions.create(opts)];
                    case 1:
                        stream = _s.sent();
                        content = '';
                        reasoningContent = '';
                        toolCallsAccum = {};
                        STREAM_THROTTLE_MS = 80;
                        lastEmitTime = 0;
                        lastThinkingEmitTime = 0;
                        _s.label = 2;
                    case 2:
                        _s.trys.push([2, 15, 16, 21]);
                        _a = true, _b = __asyncValues(stream);
                        _s.label = 3;
                    case 3: return [4 /*yield*/, _b.next()];
                    case 4:
                        if (!(_c = _s.sent(), _e = _c.done, !_e)) return [3 /*break*/, 14];
                        _g = _c.value;
                        _a = false;
                        chunk = _g;
                        // Usage can arrive in a final chunk with choices: [] - must process BEFORE any continue
                        if (chunk.usage) {
                            usage = chunk.usage;
                            totalUsage.promptTokens += chunk.usage.prompt_tokens || 0;
                            totalUsage.completionTokens += chunk.usage.completion_tokens || 0;
                            totalUsage.totalTokens += chunk.usage.total_tokens || 0;
                        }
                        choice = (_h = chunk.choices) === null || _h === void 0 ? void 0 : _h[0];
                        if (!choice)
                            return [3 /*break*/, 13]; // Usage-only chunk (choices empty) - we already captured usage above
                        if (choice.finish_reason) {
                            finishReason = choice.finish_reason;
                        }
                        delta = choice.delta || {};
                        reasoningDelta = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
                        if (!(reasoningDelta && callbacks.onThinkingStreamStart && callbacks.onThinkingStreamChunk)) return [3 /*break*/, 8];
                        reasoningContent += reasoningDelta;
                        if (!!thinkingLogId) return [3 /*break*/, 6];
                        return [4 /*yield*/, callbacks.onThinkingStreamStart()];
                    case 5:
                        thinkingLogId = _s.sent();
                        _s.label = 6;
                    case 6:
                        now = Date.now();
                        if (!(now - lastThinkingEmitTime >= STREAM_THROTTLE_MS && thinkingLogId)) return [3 /*break*/, 8];
                        lastThinkingEmitTime = now;
                        return [4 /*yield*/, callbacks.onThinkingStreamChunk(thinkingLogId, reasoningContent)];
                    case 7:
                        _s.sent();
                        _s.label = 8;
                    case 8:
                        if (!(typeof delta.content === 'string' && delta.content)) return [3 /*break*/, 12];
                        content += delta.content;
                        if (!!streamingLogId) return [3 /*break*/, 10];
                        return [4 /*yield*/, callbacks.onStreamStart()];
                    case 9:
                        streamingLogId = _s.sent();
                        _s.label = 10;
                    case 10:
                        now = Date.now();
                        if (!(now - lastEmitTime >= STREAM_THROTTLE_MS && streamingLogId)) return [3 /*break*/, 12];
                        lastEmitTime = now;
                        return [4 /*yield*/, callbacks.onStreamChunk(streamingLogId, content)];
                    case 11:
                        _s.sent();
                        _s.label = 12;
                    case 12:
                        if (Array.isArray(delta.tool_calls)) {
                            for (_i = 0, _d = delta.tool_calls; _i < _d.length; _i++) {
                                tc = _d[_i];
                                idx = (_j = tc.index) !== null && _j !== void 0 ? _j : 0;
                                if (!toolCallsAccum[idx]) {
                                    toolCallsAccum[idx] = { type: 'function', function: {} };
                                }
                                if (tc.id)
                                    toolCallsAccum[idx].id = tc.id;
                                if ((_k = tc.function) === null || _k === void 0 ? void 0 : _k.name)
                                    toolCallsAccum[idx].function.name = tc.function.name;
                                if ((_l = tc.function) === null || _l === void 0 ? void 0 : _l.arguments) {
                                    toolCallsAccum[idx].function.arguments = (toolCallsAccum[idx].function.arguments || '') + (tc.function.arguments || '');
                                }
                            }
                        }
                        _s.label = 13;
                    case 13:
                        _a = true;
                        return [3 /*break*/, 3];
                    case 14: return [3 /*break*/, 21];
                    case 15:
                        e_1_1 = _s.sent();
                        e_1 = { error: e_1_1 };
                        return [3 /*break*/, 21];
                    case 16:
                        _s.trys.push([16, , 19, 20]);
                        if (!(!_a && !_e && (_f = _b.return))) return [3 /*break*/, 18];
                        return [4 /*yield*/, _f.call(_b)];
                    case 17:
                        _s.sent();
                        _s.label = 18;
                    case 18: return [3 /*break*/, 20];
                    case 19:
                        if (e_1) throw e_1.error;
                        return [7 /*endfinally*/];
                    case 20: return [7 /*endfinally*/];
                    case 21:
                        if (!(streamingLogId && content)) return [3 /*break*/, 23];
                        return [4 /*yield*/, callbacks.onStreamChunk(streamingLogId, content)];
                    case 22:
                        _s.sent();
                        _s.label = 23;
                    case 23:
                        if (!(thinkingLogId && reasoningContent && callbacks.onThinkingStreamChunk)) return [3 /*break*/, 25];
                        return [4 /*yield*/, callbacks.onThinkingStreamChunk(thinkingLogId, reasoningContent)];
                    case 24:
                        _s.sent();
                        _s.label = 25;
                    case 25:
                        if (!(!thinkingLogId && callbacks.onReasoningTokensUsed && usage)) return [3 /*break*/, 27];
                        u = usage;
                        reasoningTokens = (_r = (_q = (_o = (_m = u === null || u === void 0 ? void 0 : u.completion_tokens_details) === null || _m === void 0 ? void 0 : _m.reasoning_tokens) !== null && _o !== void 0 ? _o : (_p = u === null || u === void 0 ? void 0 : u.output_tokens_details) === null || _p === void 0 ? void 0 : _p.reasoning_tokens) !== null && _q !== void 0 ? _q : u === null || u === void 0 ? void 0 : u.reasoning_tokens) !== null && _r !== void 0 ? _r : 0;
                        if (!(reasoningTokens > 0)) return [3 /*break*/, 27];
                        return [4 /*yield*/, callbacks.onReasoningTokensUsed(reasoningTokens)];
                    case 26:
                        _s.sent();
                        _s.label = 27;
                    case 27:
                        toolCallsArray = Object.keys(toolCallsAccum)
                            .map(function (k) { return Number(k); })
                            .sort(function (a, b) { return a - b; })
                            .map(function (idx) { return toolCallsAccum[idx]; })
                            .filter(function (tc) { var _a; return tc.id && ((_a = tc.function) === null || _a === void 0 ? void 0 : _a.name); });
                        message = {
                            role: 'assistant',
                            content: content || null,
                        };
                        if (toolCallsArray.length > 0) {
                            message.tool_calls = toolCallsArray.map(function (tc) { return ({
                                id: tc.id,
                                type: 'function',
                                function: { name: tc.function.name, arguments: tc.function.arguments || '{}' },
                            }); });
                        }
                        return [2 /*return*/, { message: message, usage: usage, finish_reason: finishReason, streamingLogId: streamingLogId }];
                }
            });
        });
    };
    /**
     * Main execution method that mimics Scrapybara's act() functionality
     */
    OpenAIAgentExecutor.prototype.act = function (options) {
        return __awaiter(this, void 0, void 0, function () {
            var model, tools, system, prompt, initialMessages, schema, onStep, _a, maxIterations, _b, temperature, _c, reasoningEffort, _d, verbosity, _e, useStreaming, onStreamStart, onStreamChunk, onThinkingStreamStart, onThinkingStreamChunk, onReasoningTokensUsed, deploymentName, messages, openaiTools, steps, totalUsage, iterations, finalText, finalOutput, lastScreenshotHash, consecutiveIdenticalScreenshots, MAX_SCREENSHOT_HISTORY, screenshotHistory, MAX_ITERATIONS_WITHOUT_OUTPUT, iterationsWithoutOutput, _loop_1, this_1, state_1;
            var _f, _g, _h, _j, _k, _l;
            return __generator(this, function (_m) {
                switch (_m.label) {
                    case 0:
                        model = options.model, tools = options.tools, system = options.system, prompt = options.prompt, initialMessages = options.messages, schema = options.schema, onStep = options.onStep, _a = options.maxIterations, maxIterations = _a === void 0 ? 50 : _a, _b = options.temperature, temperature = _b === void 0 ? 1 : _b, _c = options.reasoningEffort, reasoningEffort = _c === void 0 ? 'low' : _c, _d = options.verbosity, verbosity = _d === void 0 ? 'low' : _d, _e = options.stream, useStreaming = _e === void 0 ? false : _e, onStreamStart = options.onStreamStart, onStreamChunk = options.onStreamChunk, onThinkingStreamStart = options.onThinkingStreamStart, onThinkingStreamChunk = options.onThinkingStreamChunk, onReasoningTokensUsed = options.onReasoningTokensUsed;
                        deploymentName = model || this.deployment;
                        // Log tools information for debugging
                        console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [EXECUTOR] Initializing with ".concat(tools.length, " tool(s):"));
                        tools.forEach(function (tool, index) {
                            console.log("  ".concat(index + 1, ". ").concat(tool.name, " - ").concat(tool.description || 'No description'));
                            if (tool.parameters) {
                                var isZodSchema = typeof tool.parameters === 'object' && '_def' in tool.parameters;
                                console.log("     Parameters: ".concat(isZodSchema ? 'Zod Schema' : 'JSON Schema'));
                            }
                        });
                        messages = [];
                        if (system) {
                            messages.push({ role: 'system', content: system });
                        }
                        if (initialMessages) {
                            messages.push.apply(messages, initialMessages);
                        }
                        else if (prompt) {
                            messages.push({ role: 'user', content: prompt });
                        }
                        openaiTools = tools.map(function (tool) {
                            var parameters;
                            // Check if parameters is a Zod schema (from Scrapybara SDK)
                            if (tool.parameters && typeof tool.parameters === 'object' && '_def' in tool.parameters) {
                                // It's a Zod schema, convert to JSON Schema
                                parameters = (0, zod_to_json_schema_1.zodToJsonSchema)(tool.parameters, {
                                    target: 'openApi3',
                                    $refStrategy: 'none',
                                });
                            }
                            else {
                                // It's already a JSON Schema or undefined
                                parameters = tool.parameters || { type: 'object', properties: {} };
                            }
                            return {
                                type: 'function',
                                function: {
                                    name: tool.name,
                                    description: tool.description || "Tool: ".concat(tool.name),
                                    parameters: parameters,
                                },
                            };
                        });
                        steps = [];
                        totalUsage = {
                            promptTokens: 0,
                            completionTokens: 0,
                            totalTokens: 0,
                        };
                        iterations = 0;
                        finalText = '';
                        finalOutput = undefined;
                        lastScreenshotHash = null;
                        consecutiveIdenticalScreenshots = 0;
                        MAX_SCREENSHOT_HISTORY = 5;
                        screenshotHistory = [];
                        MAX_ITERATIONS_WITHOUT_OUTPUT = 30;
                        iterationsWithoutOutput = 0;
                        _loop_1 = function () {
                            var iterationStartTime, imagesBefore, imagesAfter, completionOptions, shouldForceJson, isReasoningModel, jsonSchema, useStreamingPath, useThinkingStream, response, streamCallbacks, azureStartTime, completion, azureEndTime, azureDuration, choice, message, step, parsed, validated, toolCalls, _i, _o, tc, toolResults, allToolsStartTime, collectedImages, _loop_2, _p, toolCalls_1, toolCall, allToolsEndTime, allToolsDuration, toolMessageIds_1, missingToolCallIds, shouldIncludeScreenshots, screenshotsToSend, isHistorical, historyNote, imageContent_1, streamingLogId, shouldStop, iterationEndTime, iterationDuration, error_1;
                            return __generator(this, function (_q) {
                                switch (_q.label) {
                                    case 0:
                                        iterations++;
                                        console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [EXECUTOR] Iteration ".concat(iterations, "/").concat(maxIterations));
                                        // Safety check: if schema is provided but we haven't received output after many iterations, stop
                                        if (schema && iterationsWithoutOutput > MAX_ITERATIONS_WITHOUT_OUTPUT) {
                                            console.error("\u26A0\uFE0F [EXECUTOR] Safety limit reached: ".concat(iterationsWithoutOutput, " iterations without structured output. Stopping."));
                                            return [2 /*return*/, "break"];
                                        }
                                        _q.label = 1;
                                    case 1:
                                        _q.trys.push([1, 13, , 14]);
                                        iterationStartTime = Date.now();
                                        console.log("\n\u23F1\uFE0F ========== ITERATION ".concat(iterations, " TIMING BREAKDOWN =========="));
                                        imagesBefore = messages.filter(function (m) {
                                            return m.role === 'user' && Array.isArray(m.content) &&
                                                m.content.some(function (c) { return c.type === 'image_url'; });
                                        }).length;
                                        filterImages(messages, MAX_SCREENSHOT_HISTORY);
                                        imagesAfter = messages.filter(function (m) {
                                            return m.role === 'user' && Array.isArray(m.content) &&
                                                m.content.some(function (c) { return c.type === 'image_url'; });
                                        }).length;
                                        if (imagesBefore > imagesAfter) {
                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [IMAGE_FILTER] Cleaned ".concat(imagesBefore - imagesAfter, " old image(s), kept ").concat(imagesAfter, " most recent"));
                                        }
                                        completionOptions = {
                                            model: deploymentName, // This is the deployment name in Azure
                                            messages: messages,
                                        };
                                        shouldForceJson = schema && iterations > 15;
                                        if (!shouldForceJson) {
                                            completionOptions.tools = openaiTools;
                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [EXECUTOR] Including tools in API call");
                                        }
                                        else {
                                            console.log("\u26A0\uFE0F [EXECUTOR] Forcing JSON output - removing tools (iteration ".concat(iterations, ")"));
                                        }
                                        isReasoningModel = deploymentName.includes('o1') || deploymentName.includes('o3') || deploymentName.includes('gpt-5.4');
                                        if (!isReasoningModel && temperature !== 1) {
                                            completionOptions.temperature = temperature;
                                        }
                                        // Add reasoning_effort for o-series models (GPT-5.2 family: o1, o3, etc.)
                                        if (isReasoningModel) {
                                            // NOTE: Many Azure OpenAI deployments (like o1-mini or older o1-preview) do NOT support reasoning_effort yet
                                            // and will return an HTTP 500. Only o3-mini and o1 support it currently.
                                            // We will ONLY pass it if it's explicitly o3-mini or o1 (not o1-mini).
                                            // For safety with custom deployment names like gpt-5.4, we skip it by default unless it's strictly 'o3-mini' or 'o1'.
                                            if (deploymentName === 'o3-mini' || deploymentName === 'o1') {
                                                completionOptions.reasoning_effort = reasoningEffort; // Options: low, medium, high
                                                console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [EXECUTOR] Using reasoning_effort=".concat(reasoningEffort, " for model: ").concat(deploymentName));
                                            }
                                            else {
                                                console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [EXECUTOR] Skipping reasoning_effort for model: ".concat(deploymentName, " to avoid Azure HTTP 500"));
                                            }
                                        }
                                        // Add response format for structured output if schema is provided
                                        if (schema) {
                                            jsonSchema = this_1.zodToJsonSchema(schema);
                                            completionOptions.response_format = {
                                                type: 'json_schema',
                                                json_schema: {
                                                    name: 'response',
                                                    schema: jsonSchema,
                                                    strict: true,
                                                },
                                            };
                                        }
                                        // Debug: Log messages before API call to identify base64 issues
                                        console.log("\uD83D\uDD0D [DEBUG] Messages being sent to OpenAI:", JSON.stringify(messages, null, 2).substring(0, 2000));
                                        useStreamingPath = useStreaming && onStreamStart && onStreamChunk && !schema;
                                        useThinkingStream = useStreamingPath && onThinkingStreamStart && onThinkingStreamChunk;
                                        response = void 0;
                                        if (!useStreamingPath) return [3 /*break*/, 3];
                                        streamCallbacks = {
                                            onStreamStart: onStreamStart,
                                            onStreamChunk: onStreamChunk,
                                            onReasoningTokensUsed: onReasoningTokensUsed,
                                        };
                                        if (useThinkingStream) {
                                            streamCallbacks.onThinkingStreamStart = onThinkingStreamStart;
                                            streamCallbacks.onThinkingStreamChunk = onThinkingStreamChunk;
                                        }
                                        return [4 /*yield*/, this_1.runStreamingCompletion(completionOptions, streamCallbacks, totalUsage)];
                                    case 2:
                                        response = _q.sent();
                                        return [3 /*break*/, 5];
                                    case 3:
                                        // Non-streaming path (original behavior)
                                        console.log("\u23F1\uFE0F [TIMING] Calling Azure OpenAI API...");
                                        azureStartTime = Date.now();
                                        return [4 /*yield*/, this_1.client.chat.completions.create(completionOptions)];
                                    case 4:
                                        completion = _q.sent();
                                        azureEndTime = Date.now();
                                        azureDuration = azureEndTime - azureStartTime;
                                        console.log("\u23F1\uFE0F [TIMING] Azure OpenAI response received in ".concat(azureDuration, "ms (").concat((azureDuration / 1000).toFixed(1), "s)"));
                                        choice = completion.choices[0];
                                        response = {
                                            message: choice.message,
                                            usage: completion.usage,
                                            finish_reason: (_f = choice.finish_reason) !== null && _f !== void 0 ? _f : undefined,
                                        };
                                        _q.label = 5;
                                    case 5:
                                        message = response.message;
                                        // Track usage
                                        if (response.usage) {
                                            totalUsage.promptTokens += response.usage.prompt_tokens;
                                            totalUsage.completionTokens += response.usage.completion_tokens;
                                            totalUsage.totalTokens += response.usage.total_tokens;
                                        }
                                        // Add assistant message to history
                                        messages.push(message);
                                        step = {
                                            text: message.content || '',
                                            usage: {
                                                promptTokens: ((_g = response.usage) === null || _g === void 0 ? void 0 : _g.prompt_tokens) || 0,
                                                completionTokens: ((_h = response.usage) === null || _h === void 0 ? void 0 : _h.completion_tokens) || 0,
                                                totalTokens: ((_j = response.usage) === null || _j === void 0 ? void 0 : _j.total_tokens) || 0,
                                            },
                                        };
                                        finalText = message.content || '';
                                        // Parse structured output if schema is provided
                                        if (schema && message.content) {
                                            try {
                                                console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [SCHEMA] Attempting to parse structured output...");
                                                parsed = JSON.parse(message.content);
                                                validated = schema.parse(parsed);
                                                step.output = validated;
                                                finalOutput = validated;
                                                iterationsWithoutOutput = 0; // Reset counter on successful parse
                                                console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [SCHEMA] \u2705 Structured output validated:", validated);
                                            }
                                            catch (error) {
                                                iterationsWithoutOutput++;
                                                console.log("\u26A0\uFE0F [SCHEMA] Iterations without output: ".concat(iterationsWithoutOutput, "/").concat(MAX_ITERATIONS_WITHOUT_OUTPUT));
                                                console.error('❌ [SCHEMA] Failed to parse structured output:', error);
                                                console.error('❌ [SCHEMA] Message content:', (_k = message.content) === null || _k === void 0 ? void 0 : _k.substring(0, 200));
                                            }
                                        }
                                        else {
                                            if (schema && !message.content) {
                                                iterationsWithoutOutput++;
                                                console.log("\u26A0\uFE0F [SCHEMA] Schema provided but no message content received (".concat(iterationsWithoutOutput, "/").concat(MAX_ITERATIONS_WITHOUT_OUTPUT, ")"));
                                            }
                                            else if (schema) {
                                                // Schema is provided but content is not structured output (probably just tool calls)
                                                iterationsWithoutOutput++;
                                            }
                                        }
                                        if (!(message.tool_calls && message.tool_calls.length > 0)) return [3 /*break*/, 10];
                                        console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOLS] Received ".concat(message.tool_calls.length, " tool_call(s) from Azure"));
                                        toolCalls = [];
                                        // Parse tool calls with error handling
                                        try {
                                            toolCalls = message.tool_calls.map(function (tc) {
                                                console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOL_PARSE] Parsing tool call: ".concat(tc.id, " - ").concat(tc.function.name));
                                                return {
                                                    toolCallId: tc.id,
                                                    toolName: tc.function.name,
                                                    args: JSON.parse(tc.function.arguments),
                                                };
                                            });
                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOLS] \u2705 Successfully parsed ".concat(toolCalls.length, " tool call(s)"));
                                        }
                                        catch (parseError) {
                                            console.error("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOLS] \u274C Error parsing tool calls:", parseError);
                                            // Add error messages for all tool_calls to prevent Azure error
                                            for (_i = 0, _o = message.tool_calls; _i < _o.length; _i++) {
                                                tc = _o[_i];
                                                messages.push({
                                                    role: 'tool',
                                                    tool_call_id: tc.id,
                                                    name: tc.function.name,
                                                    content: "Error parsing tool call arguments: ".concat(parseError.message),
                                                });
                                            }
                                            return [2 /*return*/, "continue"];
                                        }
                                        step.toolCalls = toolCalls;
                                        console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOLS] Executing ".concat(toolCalls.length, " tool call(s):"));
                                        toolCalls.forEach(function (tc, idx) {
                                            console.log("  ".concat(idx + 1, ". ").concat(tc.toolName, " (").concat(tc.toolCallId, ") - Args:"), JSON.stringify(tc.args).substring(0, 100));
                                        });
                                        toolResults = [];
                                        allToolsStartTime = Date.now();
                                        collectedImages = [];
                                        _loop_2 = function (toolCall) {
                                            var toolStartTime, tool, errorMsg, result, duration_1, isScrapybaraTool, logPrefix, keys, logPrefix, logPrefix, toolEndTime, toolDuration, _r, cleanedResult, base64Image, screenshotHash, error_2, toolEndTime, toolDuration, errorMessage;
                                            return __generator(this, function (_s) {
                                                switch (_s.label) {
                                                    case 0:
                                                        toolStartTime = Date.now();
                                                        console.log("\u23F1\uFE0F [TOOL_START] ".concat(toolCall.toolName, " (").concat(toolCall.toolCallId, ") - Starting execution..."));
                                                        tool = tools.find(function (t) { return t.name === toolCall.toolName; });
                                                        if (!tool) {
                                                            errorMsg = "Error: Tool ".concat(toolCall.toolName, " not found");
                                                            console.error("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOL_ERROR] Tool not found: ".concat(toolCall.toolName, " (").concat(toolCall.toolCallId, ")"));
                                                            toolResults.push({
                                                                toolCallId: toolCall.toolCallId,
                                                                toolName: toolCall.toolName,
                                                                result: errorMsg,
                                                                isError: true,
                                                            });
                                                            // CRITICAL: Must add tool message to messages array
                                                            // Otherwise Azure OpenAI will reject the next API call
                                                            messages.push({
                                                                role: 'tool',
                                                                tool_call_id: toolCall.toolCallId,
                                                                name: toolCall.toolName,
                                                                content: errorMsg,
                                                            });
                                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOL_MSG] \u2705 Added tool message for ".concat(toolCall.toolCallId));
                                                            return [2 /*return*/, "continue"];
                                                        }
                                                        _s.label = 1;
                                                    case 1:
                                                        _s.trys.push([1, 6, , 7]);
                                                        result = void 0;
                                                        if (!(toolCall.toolName === 'computer' && toolCall.args.action === 'wait')) return [3 /*break*/, 3];
                                                        duration_1 = toolCall.args.duration || 1000;
                                                        console.log("\u26A1 [WAIT_LOCAL] Executing wait locally for ".concat(duration_1, "ms instead of calling Scrapybara"));
                                                        // Execute wait locally with a simple promise
                                                        return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, duration_1); })];
                                                    case 2:
                                                        // Execute wait locally with a simple promise
                                                        _s.sent();
                                                        result = "Waited for ".concat(duration_1, "ms");
                                                        console.log("\u26A1 [WAIT_LOCAL] Local wait completed");
                                                        return [3 /*break*/, 5];
                                                    case 3:
                                                        isScrapybaraTool = ['computer', 'bash', 'edit'].includes(toolCall.toolName);
                                                        if (isScrapybaraTool) {
                                                            // Execute tool via Scrapybara SDK
                                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [SCRAPYBARA] Calling ".concat(toolCall.toolName, ".execute() with Scrapybara SDK..."));
                                                        }
                                                        else {
                                                            // Execute tool locally (e.g., generate_image)
                                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [LOCAL] Executing ".concat(toolCall.toolName, ".execute() locally..."));
                                                        }
                                                        return [4 /*yield*/, tool.execute(toolCall.args)];
                                                    case 4:
                                                        result = _s.sent();
                                                        // Log raw result details for debugging
                                                        if (result === undefined || result === null) {
                                                            logPrefix = isScrapybaraTool ? '[SCRAPYBARA]' : '[LOCAL]';
                                                            console.warn("\u26A0\uFE0F ".concat(logPrefix, " ").concat(toolCall.toolName, " returned ").concat(result === undefined ? 'undefined' : 'null'));
                                                        }
                                                        else if (typeof result === 'object') {
                                                            keys = Object.keys(result);
                                                            logPrefix = isScrapybaraTool ? '[SCRAPYBARA]' : '[LOCAL]';
                                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E ".concat(logPrefix, " Result is object with keys: [").concat(keys.join(', '), "]"));
                                                            // Scrapybara-specific logging (only for Scrapybara tools)
                                                            if (isScrapybaraTool) {
                                                                // CRITICAL: Check for errors and validate action execution
                                                                if (result.error && result.error.length > 0) {
                                                                    console.error("\u26A0\uFE0F [SCRAPYBARA] Error field contains: \"".concat(result.error, "\""));
                                                                }
                                                                if (result.output && result.output.length > 0) {
                                                                    console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [SCRAPYBARA] Output: \"".concat(result.output.substring(0, 200), "\""));
                                                                }
                                                                // Check for common error fields
                                                                if (result.failed || result.success === false) {
                                                                    console.error("\u26A0\uFE0F [SCRAPYBARA] Result indicates failure:", result.failed || 'success=false');
                                                                }
                                                                // CRITICAL: For non-screenshot actions, empty output+error might indicate failure
                                                                if (toolCall.args.action !== 'take_screenshot' &&
                                                                    (!result.output || result.output === '') &&
                                                                    (!result.error || result.error === '')) {
                                                                    console.warn("\u26A0\uFE0F [SCRAPYBARA] ".concat(toolCall.args.action, " returned empty output and error - action may not have executed"));
                                                                    console.warn("\u26A0\uFE0F [SCRAPYBARA] This usually indicates the browser window lost focus or X11 display has input issues");
                                                                    console.warn("\u26A0\uFE0F [SCRAPYBARA] Full result keys:", Object.keys(result).join(', '));
                                                                }
                                                                // Log system messages if present - THIS MAY CONTAIN THE REAL ERROR
                                                                if (result.system) {
                                                                    console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [SCRAPYBARA] System info:", JSON.stringify(result.system));
                                                                    // Check if system contains error information
                                                                    if (typeof result.system === 'object') {
                                                                        if (result.system.error || result.system.message || result.system.status) {
                                                                            console.error("\uD83D\uDEA8 [SCRAPYBARA_SYSTEM] System field indicates issue:", result.system);
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                        else {
                                                            logPrefix = isScrapybaraTool ? '[SCRAPYBARA]' : '[LOCAL]';
                                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E ".concat(logPrefix, " Result type: ").concat(typeof result, ", length: ").concat(String(result).length));
                                                        }
                                                        _s.label = 5;
                                                    case 5:
                                                        toolEndTime = Date.now();
                                                        toolDuration = toolEndTime - toolStartTime;
                                                        console.log("\u23F1\uFE0F [TOOL_END] ".concat(toolCall.toolName, " completed in ").concat(toolDuration, "ms (").concat((toolDuration / 1000).toFixed(1), "s)"));
                                                        _r = this_1.extractBase64Image(result), cleanedResult = _r.cleanedResult, base64Image = _r.base64Image;
                                                        if (base64Image) {
                                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOL_IMAGE] ".concat(toolCall.toolName, " returned base64 image (").concat(base64Image.length, " chars)"));
                                                            screenshotHash = base64Image.substring(0, 100);
                                                            if (lastScreenshotHash === screenshotHash) {
                                                                consecutiveIdenticalScreenshots++;
                                                                console.warn("\u26A0\uFE0F [SCREENSHOT_DUPLICATE] Screenshot #".concat(consecutiveIdenticalScreenshots + 1, " is identical to previous one - browser may not be responding to actions"));
                                                                // Alert if we have too many identical screenshots
                                                                if (consecutiveIdenticalScreenshots >= 3) {
                                                                    console.error("\uD83D\uDEA8 [SCREENSHOT_DUPLICATE] ".concat(consecutiveIdenticalScreenshots + 1, " consecutive identical screenshots detected!"));
                                                                    console.error("\uD83D\uDEA8 [SCREENSHOT_DUPLICATE] Browser is likely NOT responding to computer tool actions");
                                                                    console.error("\uD83D\uDEA8 [SCREENSHOT_DUPLICATE] Recent actions: ".concat(toolCalls.map(function (tc) { return "".concat(tc.toolName, "(").concat(tc.args.action, ")"); }).join(', ')));
                                                                }
                                                            }
                                                            else {
                                                                if (consecutiveIdenticalScreenshots > 0) {
                                                                    console.log("\u2705 [SCREENSHOT_CHANGED] Screenshot changed after ".concat(consecutiveIdenticalScreenshots + 1, " identical ones"));
                                                                }
                                                                consecutiveIdenticalScreenshots = 0;
                                                                lastScreenshotHash = screenshotHash;
                                                            }
                                                            // Collect image to add AFTER all tool messages
                                                            collectedImages.push(base64Image);
                                                            // Add to persistent screenshot history for cross-iteration context
                                                            screenshotHistory.push(base64Image);
                                                            // Keep only last N screenshots to manage token usage
                                                            if (screenshotHistory.length > MAX_SCREENSHOT_HISTORY) {
                                                                screenshotHistory.shift(); // Remove oldest screenshot
                                                            }
                                                        }
                                                        else {
                                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOL_NO_IMAGE] ".concat(toolCall.toolName, " - no image in result"));
                                                        }
                                                        // Store FULL result in toolResults for onStep callback (with image reference)
                                                        toolResults.push({
                                                            toolCallId: toolCall.toolCallId,
                                                            toolName: toolCall.toolName,
                                                            result: result, // Keep original result with image for logging
                                                            base64Image: base64Image, // CRITICAL: Preserve extracted image for logging
                                                            cleanedResult: cleanedResult, // Also include cleaned version
                                                            isError: false,
                                                        });
                                                        // Add tool message with text only (NO image)
                                                        // DO NOT add user messages here - they will be added AFTER all tool messages
                                                        messages.push({
                                                            role: 'tool',
                                                            tool_call_id: toolCall.toolCallId,
                                                            name: toolCall.toolName,
                                                            content: typeof cleanedResult === 'string' ? cleanedResult : JSON.stringify(cleanedResult),
                                                        });
                                                        console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOL_MSG] \u2705 Added tool message for ".concat(toolCall.toolCallId));
                                                        return [3 /*break*/, 7];
                                                    case 6:
                                                        error_2 = _s.sent();
                                                        toolEndTime = Date.now();
                                                        toolDuration = toolEndTime - toolStartTime;
                                                        errorMessage = error_2.message || String(error_2);
                                                        console.error("\u23F1\uFE0F [TOOL_ERROR] ".concat(toolCall.toolName, " (").concat(toolCall.toolCallId, ") failed after ").concat(toolDuration, "ms (").concat((toolDuration / 1000).toFixed(1), "s) - ").concat(errorMessage.substring(0, 100)));
                                                        toolResults.push({
                                                            toolCallId: toolCall.toolCallId,
                                                            toolName: toolCall.toolName,
                                                            result: errorMessage,
                                                            isError: true,
                                                        });
                                                        // Add error to messages
                                                        messages.push({
                                                            role: 'tool',
                                                            tool_call_id: toolCall.toolCallId,
                                                            name: toolCall.toolName,
                                                            content: "Error: ".concat(errorMessage),
                                                        });
                                                        console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOL_MSG] \u2705 Added error tool message for ".concat(toolCall.toolCallId));
                                                        return [3 /*break*/, 7];
                                                    case 7: return [2 /*return*/];
                                                }
                                            });
                                        };
                                        _p = 0, toolCalls_1 = toolCalls;
                                        _q.label = 6;
                                    case 6:
                                        if (!(_p < toolCalls_1.length)) return [3 /*break*/, 9];
                                        toolCall = toolCalls_1[_p];
                                        return [5 /*yield**/, _loop_2(toolCall)];
                                    case 7:
                                        _q.sent();
                                        _q.label = 8;
                                    case 8:
                                        _p++;
                                        return [3 /*break*/, 6];
                                    case 9:
                                        allToolsEndTime = Date.now();
                                        allToolsDuration = allToolsEndTime - allToolsStartTime;
                                        console.log("\u23F1\uFE0F [TOOLS_TOTAL] All ".concat(toolCalls.length, " tool(s) executed in ").concat(allToolsDuration, "ms (").concat((allToolsDuration / 1000).toFixed(1), "s)"));
                                        toolMessageIds_1 = new Set(messages
                                            .filter(function (m) { return m.role === 'tool'; })
                                            .map(function (m) { return m.tool_call_id; }));
                                        missingToolCallIds = toolCalls.filter(function (tc) { return !toolMessageIds_1.has(tc.toolCallId); });
                                        if (missingToolCallIds.length > 0) {
                                            console.error("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOLS] \u274C CRITICAL: ".concat(missingToolCallIds.length, " tool_call_id(s) missing tool messages!"));
                                            missingToolCallIds.forEach(function (tc) {
                                                console.error("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOLS] \u274C Missing: ".concat(tc.toolCallId, " (").concat(tc.toolName, ")"));
                                                // Add emergency error message to prevent Azure error
                                                messages.push({
                                                    role: 'tool',
                                                    tool_call_id: tc.toolCallId,
                                                    name: tc.toolName,
                                                    content: "Error: Tool execution failed unexpectedly. No response recorded.",
                                                });
                                            });
                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOLS] \u2705 Added emergency tool messages for missing tool_call_ids");
                                        }
                                        else {
                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [TOOLS] \u2705 All ".concat(toolCalls.length, " tool_call_ids have corresponding tool messages"));
                                        }
                                        shouldIncludeScreenshots = iterations <= 3 || iterations % 3 === 0;
                                        screenshotsToSend = screenshotHistory.length > 0 ? screenshotHistory : collectedImages;
                                        if (screenshotsToSend.length > 0 && shouldIncludeScreenshots) {
                                            isHistorical = screenshotsToSend === screenshotHistory;
                                            historyNote = isHistorical ? " (including ".concat(screenshotHistory.length, " from history for context)") : '';
                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [SCREENSHOTS] Adding ".concat(screenshotsToSend.length, " screenshot(s)").concat(historyNote, " as single user message in iteration ").concat(iterations));
                                            imageContent_1 = [
                                                {
                                                    type: 'text',
                                                    text: screenshotsToSend.length === 1
                                                        ? 'Here is the visual result from the previous action:'
                                                        : "Here are the last ".concat(screenshotsToSend.length, " screenshots showing the progression of actions (most recent last):")
                                                }
                                            ];
                                            // Add all screenshots from history (oldest to newest)
                                            screenshotsToSend.forEach(function (image, idx) {
                                                imageContent_1.push({
                                                    type: 'image_url',
                                                    image_url: {
                                                        url: image,
                                                        detail: 'low' // Use 'low' to save tokens (85 tokens vs 765+)
                                                    }
                                                });
                                            });
                                            messages.push({
                                                role: 'user',
                                                content: imageContent_1
                                            });
                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [SCREENSHOTS] \u2705 Added user message with ".concat(screenshotsToSend.length, " image(s)"));
                                        }
                                        else if (screenshotsToSend.length > 0) {
                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [SCREENSHOTS_SKIP] Skipping ".concat(screenshotsToSend.length, " screenshot(s) in iteration ").concat(iterations, " to reduce content filter risk"));
                                        }
                                        step.toolResults = toolResults;
                                        // If schema is provided and we've executed tools, add reminder to provide structured output
                                        // Only remind after iteration 6 and only if we're approaching the force-json threshold (iteration 10)
                                        if (schema && toolResults.length > 0 && iterations >= 8 && iterations % 2 === 0) {
                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [REMINDER] Adding gentle reminder to request structured output (iteration ".concat(iterations, ")"));
                                            messages.push({
                                                role: 'user',
                                                content: "\u26A0\uFE0F REMINDER: When you complete the current step objective, provide your response in JSON format with event, step, and assistant_message fields."
                                            });
                                        }
                                        _q.label = 10;
                                    case 10:
                                        // Add step to history
                                        steps.push(step);
                                        if (!onStep) return [3 /*break*/, 12];
                                        streamingLogId = response.streamingLogId;
                                        return [4 /*yield*/, onStep(step, streamingLogId ? { streamingLogId: streamingLogId } : undefined)];
                                    case 11:
                                        _q.sent();
                                        _q.label = 12;
                                    case 12:
                                        shouldStop = response.finish_reason === 'stop' ||
                                            (schema && finalOutput !== undefined) ||
                                            !message.tool_calls;
                                        console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [EXECUTOR] Should stop: ".concat(shouldStop, " (finish_reason=").concat(response.finish_reason, ", hasSchema=").concat(!!schema, ", hasOutput=").concat(finalOutput !== undefined, ", hasToolCalls=").concat(!!message.tool_calls, ")"));
                                        iterationEndTime = Date.now();
                                        iterationDuration = iterationEndTime - iterationStartTime;
                                        console.log("\u23F1\uFE0F [ITERATION_TOTAL] Iteration ".concat(iterations, " completed in ").concat(iterationDuration, "ms (").concat((iterationDuration / 1000).toFixed(1), "s)"));
                                        console.log("\u23F1\uFE0F ========== END ITERATION ".concat(iterations, " ==========\n"));
                                        if (shouldStop) {
                                            console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [EXECUTOR] Breaking loop after ".concat(iterations, " iterations"));
                                            return [2 /*return*/, "break"];
                                        }
                                        console.log("\u208D\u1422\u2022(\u072B)\u2022\u1422\u208E [EXECUTOR] Continuing to next iteration...");
                                        return [3 /*break*/, 14];
                                    case 13:
                                        error_1 = _q.sent();
                                        console.error('Error in agent execution:', error_1);
                                        // Handle content filter errors from Azure OpenAI
                                        if (error_1.code === 'content_filter' || ((_l = error_1.message) === null || _l === void 0 ? void 0 : _l.includes('content management policy'))) {
                                            console.error('❌ [CONTENT_FILTER] Azure OpenAI blocked the response due to content policy');
                                            console.error('❌ [CONTENT_FILTER] This may be a false positive. Consider:');
                                            console.error('   1. Adjusting content filter settings in Azure Portal');
                                            console.error('   2. Reviewing recent screenshots for sensitive content');
                                            console.error('   3. Modifying the system prompt');
                                            return [2 /*return*/, { value: {
                                                        messages: messages,
                                                        steps: steps,
                                                        text: 'Content filter triggered - execution stopped',
                                                        output: schema ? {
                                                            event: 'step_failed',
                                                            step: iterations,
                                                            assistant_message: 'Azure OpenAI content filter triggered. The response was blocked due to content policy. This may be a false positive.'
                                                        } : undefined,
                                                        usage: totalUsage,
                                                    } }];
                                        }
                                        // If error contains info about missing tool responses, it means we have an inconsistent state
                                        // This can happen if the API call was made with tool_calls but messages don't have matching tool responses
                                        if (error_1.message && error_1.message.includes('tool_call_id')) {
                                            console.error('⚠️ Tool call mismatch detected. Messages state:', JSON.stringify(messages.slice(-5), null, 2));
                                        }
                                        throw error_1;
                                    case 14: return [2 /*return*/];
                                }
                            });
                        };
                        this_1 = this;
                        _m.label = 1;
                    case 1:
                        if (!(iterations < maxIterations)) return [3 /*break*/, 3];
                        return [5 /*yield**/, _loop_1()];
                    case 2:
                        state_1 = _m.sent();
                        if (typeof state_1 === "object")
                            return [2 /*return*/, state_1.value];
                        if (state_1 === "break")
                            return [3 /*break*/, 3];
                        return [3 /*break*/, 1];
                    case 3: return [2 /*return*/, {
                            messages: messages,
                            steps: steps,
                            text: finalText,
                            output: finalOutput,
                            usage: totalUsage,
                        }];
                }
            });
        });
    };
    /**
     * Convert Zod schema to JSON Schema for OpenAI structured outputs
     */
    OpenAIAgentExecutor.prototype.zodToJsonSchema = function (schema) {
        // Basic implementation - you may want to use a library like zod-to-json-schema
        // For now, we'll create a simple converter
        var convert = function (s) {
            if (s instanceof zod_1.z.ZodObject) {
                var shape = s.shape;
                var properties = {};
                var required = [];
                for (var _i = 0, _a = Object.entries(shape); _i < _a.length; _i++) {
                    var _b = _a[_i], key = _b[0], value = _b[1];
                    properties[key] = convert(value);
                    if (!value.isOptional()) {
                        required.push(key);
                    }
                }
                return {
                    type: 'object',
                    properties: properties,
                    required: required,
                    additionalProperties: false,
                };
            }
            if (s instanceof zod_1.z.ZodString) {
                return { type: 'string' };
            }
            if (s instanceof zod_1.z.ZodNumber) {
                return { type: 'number' };
            }
            if (s instanceof zod_1.z.ZodBoolean) {
                return { type: 'boolean' };
            }
            if (s instanceof zod_1.z.ZodArray) {
                return {
                    type: 'array',
                    items: convert(s.element),
                };
            }
            if (s instanceof zod_1.z.ZodEnum) {
                return {
                    type: 'string',
                    enum: s.options,
                };
            }
            if (s instanceof zod_1.z.ZodOptional) {
                return convert(s.unwrap());
            }
            if (s instanceof zod_1.z.ZodNullable) {
                var inner = convert(s.unwrap());
                return __assign(__assign({}, inner), { nullable: true });
            }
            // Default fallback
            return { type: 'string' };
        };
        return convert(schema);
    };
    return OpenAIAgentExecutor;
}());
exports.OpenAIAgentExecutor = OpenAIAgentExecutor;
