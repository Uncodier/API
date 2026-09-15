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
exports.EmailTrackingService = void 0;
var supabase_client_1 = require("@/lib/database/supabase-client");
var task_db_1 = require("@/lib/database/task-db");
var command_utils_1 = require("@/lib/helpers/command-utils");
var EmailSendService_1 = require("../email/EmailSendService");
var EmailTrackingService = /** @class */ (function () {
    function EmailTrackingService() {
    }
    EmailTrackingService.getBaseUrl = function () {
        return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
    };
    /**
     * Inyecta rastreo de apertura y clics en el HTML de un correo.
     */
    EmailTrackingService.injectTracking = function (html, messageId) {
        if (!messageId || !(0, command_utils_1.isValidUUID)(messageId)) {
            console.warn('[EmailTrackingService] Invalid messageId for tracking injection');
            return html;
        }
        var baseUrl = this.getBaseUrl();
        // 1. Envolver todos los links <a>
        // Regex para encontrar href="..." y evitar los que ya están trackeados o son anclas internas
        var linkRegex = /href="((?!#|mailto:|tel:|javascript:)[^"]+)"/gi;
        var modifiedHtml = html.replace(linkRegex, function (match, url) {
            var encodedUrl = encodeURIComponent(url);
            var trackingUrl = "".concat(baseUrl, "/api/tracking/email?m=").concat(messageId, "&a=click&url=").concat(encodedUrl);
            return "href=\"".concat(EmailSendService_1.EmailSendService.escapeAttr(trackingUrl), "\"");
        });
        // 2. Inyectar pixel de apertura
        var openTrackingUrl = "".concat(baseUrl, "/api/tracking/email?m=").concat(messageId, "&a=open");
        var trackingPixel = "<img src=\"".concat(EmailSendService_1.EmailSendService.escapeAttr(openTrackingUrl), "\" width=\"1\" height=\"1\" style=\"display:none !important; visibility:hidden !important; opacity:0 !important;\" alt=\"\" />");
        if (modifiedHtml.includes('</body>')) {
            modifiedHtml = modifiedHtml.replace('</body>', "".concat(trackingPixel, "</body>"));
        }
        else {
            modifiedHtml += trackingPixel;
        }
        return modifiedHtml;
    };
    /**
     * Registra una apertura de correo.
     */
    EmailTrackingService.trackOpen = function (messageId, metadata) {
        return __awaiter(this, void 0, void 0, function () {
            var _a, message, fetchError, interaction, error_1;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!messageId || !(0, command_utils_1.isValidUUID)(messageId))
                            return [2 /*return*/];
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, supabase_client_1.supabaseAdmin
                                .from('messages')
                                .select('interaction')
                                .eq('id', messageId)
                                .single()];
                    case 2:
                        _a = _b.sent(), message = _a.data, fetchError = _a.error;
                        if (fetchError || !message) {
                            console.error('[EmailTrackingService] Error fetching message for tracking:', fetchError);
                            return [2 /*return*/];
                        }
                        interaction = message.interaction || {
                            open_count: 0,
                            click_count: 0,
                            opens: [],
                            clicks: []
                        };
                        interaction.open_count = (interaction.open_count || 0) + 1;
                        interaction.opens = interaction.opens || [];
                        interaction.opens.push(__assign({ at: new Date().toISOString() }, metadata));
                        return [4 /*yield*/, supabase_client_1.supabaseAdmin
                                .from('messages')
                                .update({ interaction: interaction })
                                .eq('id', messageId)];
                    case 3:
                        _b.sent();
                        console.log("[EmailTrackingService] Open tracked for message ".concat(messageId));
                        return [3 /*break*/, 5];
                    case 4:
                        error_1 = _b.sent();
                        console.error('[EmailTrackingService] Unexpected error tracking open:', error_1);
                        return [3 /*break*/, 5];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Registra un clic en un link y crea una tarea.
     */
    EmailTrackingService.trackClick = function (messageId, url, metadata) {
        return __awaiter(this, void 0, void 0, function () {
            var _a, message, fetchError, interaction, error_2;
            var _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!messageId || !(0, command_utils_1.isValidUUID)(messageId))
                            return [2 /*return*/];
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, 6, , 7]);
                        return [4 /*yield*/, supabase_client_1.supabaseAdmin
                                .from('messages')
                                .select('id, interaction, lead_id, site_id, user_id, conversation_id, content')
                                .eq('id', messageId)
                                .single()];
                    case 2:
                        _a = _c.sent(), message = _a.data, fetchError = _a.error;
                        if (fetchError || !message) {
                            console.error('[EmailTrackingService] Error fetching message for tracking click:', fetchError);
                            return [2 /*return*/];
                        }
                        interaction = message.interaction || {
                            open_count: 0,
                            click_count: 0,
                            opens: [],
                            clicks: []
                        };
                        interaction.click_count = (interaction.click_count || 0) + 1;
                        interaction.clicks = interaction.clicks || [];
                        interaction.clicks.push(__assign({ at: new Date().toISOString(), url: url }, metadata));
                        return [4 /*yield*/, supabase_client_1.supabaseAdmin
                                .from('messages')
                                .update({ interaction: interaction })
                                .eq('id', messageId)];
                    case 3:
                        _c.sent();
                        console.log("[EmailTrackingService] Click tracked for message ".concat(messageId, " to URL ").concat(url));
                        if (!(message.lead_id && message.site_id)) return [3 /*break*/, 5];
                        return [4 /*yield*/, (0, task_db_1.createTask)({
                                title: 'Email link clicked',
                                description: "A link was clicked in an email.\n\nURL: ".concat(url, "\nMessage ID: ").concat(messageId, "\nMessage Content Snippet: ").concat((_b = message.content) === null || _b === void 0 ? void 0 : _b.substring(0, 100), "..."),
                                type: 'email_interaction',
                                status: 'pending',
                                priority: 1,
                                user_id: message.user_id || '',
                                site_id: message.site_id,
                                lead_id: message.lead_id,
                                conversation_id: message.conversation_id
                            })];
                    case 4:
                        _c.sent();
                        console.log("[EmailTrackingService] Task created for click on message ".concat(messageId));
                        _c.label = 5;
                    case 5: return [3 /*break*/, 7];
                    case 6:
                        error_2 = _c.sent();
                        console.error('[EmailTrackingService] Unexpected error tracking click:', error_2);
                        return [3 /*break*/, 7];
                    case 7: return [2 /*return*/];
                }
            });
        });
    };
    return EmailTrackingService;
}());
exports.EmailTrackingService = EmailTrackingService;
