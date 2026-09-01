"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAzureConfigured = isAzureConfigured;
exports.skippedResult = skippedResult;
exports.probePortkeyProvider = probePortkeyProvider;
exports.probeAzureText = probeAzureText;
exports.probeGeminiText = probeGeminiText;
exports.probeVercelGateway = probeVercelGateway;
exports.probeMediaProvider = probeMediaProvider;
var portkey_ai_1 = require("portkey-ai");
var generative_ai_1 = require("@google/generative-ai");
var analyzer_config_1 = require("@/lib/config/analyzer-config");
var types_1 = require("@/lib/status/types");
var PROBE_TIMEOUT_MS = 15000;
var PROBE_MESSAGE = 'ping';
function getEnv(name) {
    var _a;
    var v = (_a = process.env[name]) === null || _a === void 0 ? void 0 : _a.trim();
    return v || undefined;
}
function hasEnv() {
    var names = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        names[_i] = arguments[_i];
    }
    return names.every(function (n) { return !!getEnv(n); });
}
function isAzureConfigured() {
    return (hasEnv('AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_CHAT_DEPLOYMENT') ||
        hasEnv('MICROSOFT_AZURE_OPENAI_ENDPOINT', 'MICROSOFT_AZURE_OPENAI_API_KEY', 'MICROSOFT_AZURE_OPENAI_DEPLOYMENT'));
}
function getAzureConfig() {
    var endpoint = getEnv('AZURE_OPENAI_ENDPOINT') || getEnv('MICROSOFT_AZURE_OPENAI_ENDPOINT');
    var apiKey = getEnv('AZURE_OPENAI_API_KEY') || getEnv('MICROSOFT_AZURE_OPENAI_API_KEY');
    var deployment = getEnv('AZURE_OPENAI_CHAT_DEPLOYMENT') ||
        getEnv('MICROSOFT_AZURE_OPENAI_DEPLOYMENT') ||
        'gpt-4o-mini';
    var apiVersion = getEnv('AZURE_OPENAI_API_VERSION') ||
        getEnv('MICROSOFT_AZURE_OPENAI_API_VERSION') ||
        '2024-09-01-preview';
    if (!endpoint || !apiKey)
        return null;
    return { endpoint: endpoint, apiKey: apiKey, deployment: deployment, apiVersion: apiVersion };
}
function usesMaxCompletionTokens(model) {
    return model.startsWith('gpt-5') || model.startsWith('o1') || model.startsWith('o3');
}
function buildChatCompletionBody(model) {
    var body = {
        messages: [{ role: 'user', content: PROBE_MESSAGE }],
        stream: false,
    };
    if (usesMaxCompletionTokens(model)) {
        body.max_completion_tokens = 100;
    }
    else {
        body.max_tokens = 10;
    }
    return body;
}
function getGeminiProbeModel() {
    return getEnv('GEMINI_STATUS_PROBE_MODEL') || 'gemini-1.5-flash';
}
function withTimeout(promise, ms) {
    return __awaiter(this, void 0, void 0, function () {
        var timer, timeout;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    timeout = new Promise(function (_, reject) {
                        timer = setTimeout(function () { return reject(new Error('PROBE_TIMEOUT')); }, ms);
                    });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, , 3, 4]);
                    return [4 /*yield*/, Promise.race([promise, timeout])];
                case 2: return [2 /*return*/, _a.sent()];
                case 3:
                    clearTimeout(timer);
                    return [7 /*endfinally*/];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function mapProbeError(err) {
    var msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('PROBE_TIMEOUT') || msg.includes('timeout')) {
        return { errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'Probe timed out' };
    }
    if (msg.includes('401') || msg.includes('403') || /unauthorized|invalid.*key/i.test(msg)) {
        return { errorCode: 'AUTH_FAILED', errorMessage: 'Authentication failed' };
    }
    if (msg.includes('429') || /rate limit/i.test(msg)) {
        return { errorCode: 'QUOTA_EXCEEDED', errorMessage: 'Rate limited' };
    }
    var safe = msg.slice(0, 200);
    safe = safe.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]');
    safe = safe.replace(/Following keys are not valid:\s*[^\s"]+/gi, 'Following keys are not valid: [redacted]');
    return { errorCode: 'PROVIDER_ERROR', errorMessage: safe.slice(0, 120) };
}
function retryOnce(fn) {
    return __awaiter(this, void 0, void 0, function () {
        var err_1, errorCode;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 6]);
                    return [4 /*yield*/, fn()];
                case 1: return [2 /*return*/, _a.sent()];
                case 2:
                    err_1 = _a.sent();
                    errorCode = mapProbeError(err_1).errorCode;
                    if (!(errorCode === 'QUOTA_EXCEEDED')) return [3 /*break*/, 5];
                    return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, 2000); })];
                case 3:
                    _a.sent();
                    return [4 /*yield*/, fn()];
                case 4: return [2 /*return*/, _a.sent()];
                case 5: throw err_1;
                case 6: return [2 /*return*/];
            }
        });
    });
}
function skippedResult(model) {
    return {
        configured: false,
        liveProbe: false,
        latencyMs: 0,
        model: model,
        skipped: true,
    };
}
function notProbedResult(model, reason) {
    return {
        configured: true,
        liveProbe: false,
        latencyMs: 0,
        model: model,
        errorCode: 'PROBE_DISABLED',
        errorMessage: reason,
    };
}
function probePortkeyProvider(modelType) {
    return __awaiter(this, void 0, void 0, function () {
        var virtualKeyMap, defaultModels, virtualKey, portkeyKey, start, portkey_1, requestOptions, model, completionBody_1, err_2, _a, errorCode, errorMessage;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    virtualKeyMap = {
                        openai: getEnv('AZURE_OPENAI_API_KEY'),
                        gemini: getEnv('GEMINI_API_KEY'),
                    };
                    defaultModels = {
                        openai: 'gpt-5-nano',
                        gemini: getGeminiProbeModel(),
                    };
                    virtualKey = virtualKeyMap[modelType];
                    portkeyKey = getEnv('PORTKEY_API_KEY');
                    if (!portkeyKey || !virtualKey) {
                        return [2 /*return*/, skippedResult(defaultModels[modelType])];
                    }
                    if (!(0, types_1.isAiProbeEnabled)()) {
                        return [2 /*return*/, notProbedResult(defaultModels[modelType], 'Live probes disabled locally')];
                    }
                    start = Date.now();
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    portkey_1 = new portkey_ai_1.default({
                        apiKey: portkeyKey,
                        virtualKey: virtualKey,
                        baseURL: 'https://api.portkey.ai/v1',
                    });
                    requestOptions = (0, analyzer_config_1.getRequestOptions)(modelType);
                    model = modelType === 'openai'
                        ? requestOptions.openai.model
                        : requestOptions.gemini.model;
                    completionBody_1 = __assign({ messages: [{ role: 'user', content: PROBE_MESSAGE }], model: model }, buildChatCompletionBody(model));
                    delete completionBody_1.stream;
                    return [4 /*yield*/, retryOnce(function () {
                            return withTimeout(portkey_1.chat.completions.create(completionBody_1), PROBE_TIMEOUT_MS);
                        })];
                case 2:
                    _b.sent();
                    return [2 /*return*/, {
                            configured: true,
                            liveProbe: true,
                            latencyMs: Date.now() - start,
                            model: model,
                        }];
                case 3:
                    err_2 = _b.sent();
                    _a = mapProbeError(err_2), errorCode = _a.errorCode, errorMessage = _a.errorMessage;
                    return [2 /*return*/, {
                            configured: true,
                            liveProbe: false,
                            latencyMs: Date.now() - start,
                            model: defaultModels[modelType],
                            errorCode: errorCode,
                            errorMessage: errorMessage,
                        }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function probeAzureText() {
    return __awaiter(this, void 0, void 0, function () {
        var azure, model, url, start, err_3, _a, errorCode, errorMessage;
        var _this = this;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    azure = getAzureConfig();
                    model = (azure === null || azure === void 0 ? void 0 : azure.deployment) || 'gpt-4o-mini';
                    if (!azure) {
                        return [2 /*return*/, skippedResult(model)];
                    }
                    if (!(0, types_1.isAiProbeEnabled)()) {
                        return [2 /*return*/, notProbedResult(model, 'Live probes disabled locally')];
                    }
                    url = "".concat(azure.endpoint.replace(/\/$/, ''), "/openai/deployments/").concat(encodeURIComponent(azure.deployment), "/chat/completions?api-version=").concat(encodeURIComponent(azure.apiVersion));
                    start = Date.now();
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, retryOnce(function () {
                            return withTimeout(fetch(url, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'api-key': azure.apiKey },
                                body: JSON.stringify(buildChatCompletionBody(azure.deployment)),
                            }).then(function (resp) { return __awaiter(_this, void 0, void 0, function () {
                                var text;
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0:
                                            if (!!resp.ok) return [3 /*break*/, 2];
                                            return [4 /*yield*/, resp.text().catch(function () { return ''; })];
                                        case 1:
                                            text = _a.sent();
                                            throw new Error("Azure probe failed: ".concat(resp.status, " ").concat(text));
                                        case 2: return [2 /*return*/];
                                    }
                                });
                            }); }), PROBE_TIMEOUT_MS);
                        })];
                case 2:
                    _b.sent();
                    return [2 /*return*/, { configured: true, liveProbe: true, latencyMs: Date.now() - start, model: azure.deployment }];
                case 3:
                    err_3 = _b.sent();
                    _a = mapProbeError(err_3), errorCode = _a.errorCode, errorMessage = _a.errorMessage;
                    return [2 /*return*/, {
                            configured: true,
                            liveProbe: false,
                            latencyMs: Date.now() - start,
                            model: azure.deployment,
                            errorCode: errorCode,
                            errorMessage: errorMessage,
                        }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function probeGeminiText() {
    return __awaiter(this, void 0, void 0, function () {
        var model, apiKey, start, err_4, _a, errorCode, errorMessage;
        var _this = this;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    model = getGeminiProbeModel();
                    apiKey = getEnv('GEMINI_API_KEY');
                    if (!apiKey) {
                        return [2 /*return*/, skippedResult(model)];
                    }
                    if (!(0, types_1.isAiProbeEnabled)()) {
                        return [2 /*return*/, notProbedResult(model, 'Live probes disabled locally')];
                    }
                    start = Date.now();
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, retryOnce(function () {
                            return withTimeout((function () { return __awaiter(_this, void 0, void 0, function () {
                                var genAI, m;
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0:
                                            genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
                                            m = genAI.getGenerativeModel({ model: model });
                                            return [4 /*yield*/, m.generateContent({
                                                    contents: [{ role: 'user', parts: [{ text: PROBE_MESSAGE }] }],
                                                    generationConfig: { maxOutputTokens: 10 },
                                                })];
                                        case 1:
                                            _a.sent();
                                            return [2 /*return*/];
                                    }
                                });
                            }); })(), PROBE_TIMEOUT_MS);
                        })];
                case 2:
                    _b.sent();
                    return [2 /*return*/, { configured: true, liveProbe: true, latencyMs: Date.now() - start, model: model }];
                case 3:
                    err_4 = _b.sent();
                    _a = mapProbeError(err_4), errorCode = _a.errorCode, errorMessage = _a.errorMessage;
                    return [2 /*return*/, {
                            configured: true,
                            liveProbe: false,
                            latencyMs: Date.now() - start,
                            model: model,
                            errorCode: errorCode,
                            errorMessage: errorMessage,
                        }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function probeVercelGateway() {
    return __awaiter(this, void 0, void 0, function () {
        var model, baseURL, apiKey, start, err_5, _a, errorCode, errorMessage;
        var _this = this;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    model = 'gpt-4o-mini';
                    baseURL = getEnv('VERCEL_AI_GATEWAY_OPENAI');
                    apiKey = getEnv('VERCEL_AI_GATEWAY_API_KEY');
                    if (!baseURL || !apiKey) {
                        return [2 /*return*/, skippedResult(model)];
                    }
                    if (!(0, types_1.isAiProbeEnabled)()) {
                        return [2 /*return*/, notProbedResult(model, 'Live probes disabled locally')];
                    }
                    start = Date.now();
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, retryOnce(function () {
                            return withTimeout(fetch("".concat(baseURL.replace(/\/$/, ''), "/v1/chat/completions"), {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    Authorization: "Bearer ".concat(apiKey),
                                },
                                body: JSON.stringify(__assign({ model: model, messages: [{ role: 'user', content: PROBE_MESSAGE }] }, buildChatCompletionBody(model))),
                            }).then(function (resp) { return __awaiter(_this, void 0, void 0, function () {
                                var text;
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0:
                                            if (!!resp.ok) return [3 /*break*/, 2];
                                            return [4 /*yield*/, resp.text().catch(function () { return ''; })];
                                        case 1:
                                            text = _a.sent();
                                            throw new Error("Vercel gateway probe failed: ".concat(resp.status, " ").concat(text));
                                        case 2: return [2 /*return*/];
                                    }
                                });
                            }); }), PROBE_TIMEOUT_MS);
                        })];
                case 2:
                    _b.sent();
                    return [2 /*return*/, { configured: true, liveProbe: true, latencyMs: Date.now() - start, model: model }];
                case 3:
                    err_5 = _b.sent();
                    _a = mapProbeError(err_5), errorCode = _a.errorCode, errorMessage = _a.errorMessage;
                    return [2 /*return*/, {
                            configured: true,
                            liveProbe: false,
                            latencyMs: Date.now() - start,
                            model: model,
                            errorCode: errorCode,
                            errorMessage: errorMessage,
                        }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/** Image/video/audio: live probe via same text path when only env is set */
function probeMediaProvider(name, requiredEnv, fallbackProbe) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            if (!hasEnv.apply(void 0, requiredEnv)) {
                return [2 /*return*/, skippedResult(name)];
            }
            return [2 /*return*/, fallbackProbe()];
        });
    });
}
