"use strict";
/**
 * SentEmailDuplicationService - Servicio especializado para detectar y prevenir duplicados en emails enviados
 * Maneja tanto la validación a nivel de base de datos como la validación temporal/semántica
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SentEmailDuplicationService = void 0;
var supabase_client_1 = require("@/lib/database/supabase-client");
var SyncedObjectsService_1 = require("@/lib/services/synced-objects/SyncedObjectsService");
var stable_email_deduplication_1 = require("@/lib/utils/stable-email-deduplication");
var SentEmailDuplicationService = /** @class */ (function () {
    function SentEmailDuplicationService() {
    }
    /**
     * Extrae y valida el ID más confiable de un email siguiendo RFC 5322
     */
    SentEmailDuplicationService.extractStandardEmailId = function (email) {
        console.log("[SENT_EMAIL_DEDUP] \uD83D\uDD0D Extrayendo ID est\u00E1ndar del email...");
        var candidates = [
            { field: 'messageId', value: email.messageId, priority: 1 }, // 🎯 PRIORIZAR Message-ID para correlación perfecta (RFC 5322)
            { field: 'id', value: email.id, priority: 2 },
            { field: 'uid', value: email.uid, priority: 3 },
            { field: 'message_id', value: email.message_id, priority: 4 },
            { field: 'Message_ID', value: email.Message_ID, priority: 5 },
            { field: 'ID', value: email.ID, priority: 6 }
        ];
        // Evaluar cada candidato en orden de prioridad
        for (var _i = 0, candidates_1 = candidates; _i < candidates_1.length; _i++) {
            var candidate = candidates_1[_i];
            if (this.isValidEmailId(candidate.value)) {
                var standardId = candidate.value.trim();
                return standardId;
            }
            else {
            }
        }
        // 🆕 FALLBACK: Generar ID basado en envelope (para casos donde no hay Message-ID disponible)
        var envelopeId = this.generateEnvelopeBasedId(email);
        if (envelopeId) {
            return envelopeId;
        }
        return null;
    };
    /**
     * Genera un ID estable basado en datos del envelope (to, from, subject, timestamp)
     * Este ID puede generarse tanto al enviar como al sincronizar desde IMAP
     */
    SentEmailDuplicationService.generateEnvelopeBasedId = function (email) {
        try {
            // Extraer datos requeridos
            var to = email.to || email.recipient;
            var from = email.from || email.sender;
            var subject = email.subject;
            var date = email.date || email.sent_at;
            if (!to || !from || !subject || !date) {
                return null;
            }
            // Normalizar timestamp a ventana de 1 minuto para manejar diferencias pequeñas
            var timestamp = new Date(date);
            if (isNaN(timestamp.getTime())) {
                return null;
            }
            // Redondear a DÍA para crear ventana temporal MÁS estable (emails del mismo día con mismo contenido = duplicados)
            var roundedTime = new Date(timestamp);
            roundedTime.setHours(0, 0, 0, 0); // Reset a medianoche
            var timeWindow = roundedTime.toISOString().substring(0, 10); // YYYY-MM-DD
            // 🔧 NORMALIZAR CAMPOS - Extraer solo direcciones de email para consistencia
            var normalizedTo = this.extractEmailAddress(to).toLowerCase().trim();
            var normalizedFrom = this.extractEmailAddress(from).toLowerCase().trim();
            var normalizedSubject = subject.toLowerCase().trim().substring(0, 50); // Primeros 50 chars
            // Crear hash estable usando SHA-256 simplificado
            var dataString = "".concat(timeWindow, "|").concat(normalizedTo, "|").concat(normalizedFrom, "|").concat(normalizedSubject);
            // Generar hash simple pero estable
            var hash = 0;
            for (var i = 0; i < dataString.length; i++) {
                var char = dataString.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32-bit integer
            }
            // Crear ID con formato recognizable (usando día para estabilidad)
            var envelopeId = "env-".concat(Math.abs(hash).toString(16), "-").concat(timeWindow.replace(/[:-]/g, ''));
            return envelopeId;
        }
        catch (error) {
            console.error("[SENT_EMAIL_DEDUP] \u274C Error generando ID desde envelope:", error);
            return null;
        }
    };
    /**
     * Extrae la dirección de email de un string que puede tener formato "Name <email>" o solo "email"
     */
    SentEmailDuplicationService.extractEmailAddress = function (emailString) {
        if (!emailString || typeof emailString !== 'string') {
            return '';
        }
        var trimmed = emailString.trim();
        // Si tiene formato "Name <email@domain.com>", extraer solo el email
        var emailMatch = trimmed.match(/<([^>]+)>/);
        if (emailMatch) {
            return emailMatch[1].trim();
        }
        // Si no tiene <>, asumir que es solo el email
        return trimmed;
    };
    /**
     * Valida que un ID de email sea válido y suficientemente único
     */
    SentEmailDuplicationService.isValidEmailId = function (emailId) {
        if (!emailId || typeof emailId !== 'string') {
            return false;
        }
        var trimmedId = emailId.trim();
        // Verificar longitud mínima más estricta
        if (trimmedId.length < 5) {
            return false;
        }
        // Verificar que no sea un ID demasiado genérico o común
        var genericIds = /^(1|2|3|4|5|6|7|8|9|0|test|temp|undefined|null|msg|email|id)$/i;
        if (genericIds.test(trimmedId)) {
            return false;
        }
        // Verificar que no sean solo números simples (1-999999) - UIDs de IMAP
        if (/^\d{1,6}$/.test(trimmedId)) {
            console.log("[SENT_EMAIL_DEDUP] \u274C ID rechazado por ser UID num\u00E9rico simple: \"".concat(trimmedId, "\""));
            return false;
        }
        // Verificar que no sea solo letras simples (a, b, c, etc.)
        if (/^[a-zA-Z]{1,3}$/.test(trimmedId)) {
            return false;
        }
        // Preferir IDs que tengan formato de Message-ID (contienen @ o -)
        var hasMessageIdFormat = trimmedId.includes('@') ||
            trimmedId.includes('-') ||
            trimmedId.includes('.') ||
            trimmedId.length > 10;
        if (!hasMessageIdFormat) {
            console.log("[SENT_EMAIL_DEDUP] \u26A0\uFE0F ID \"".concat(trimmedId, "\" no tiene formato de Message-ID esperado (sin @, -, . o muy corto)"));
            return false;
        }
        return true;
    };
    /**
     * Explica por qué un ID falló la validación (para debugging)
     */
    SentEmailDuplicationService.getValidationFailureReason = function (emailId) {
        if (!emailId)
            return 'valor nulo o undefined';
        if (typeof emailId !== 'string')
            return 'no es string';
        var trimmedId = emailId.trim();
        if (trimmedId.length < 5)
            return 'muy corto (< 5 caracteres)';
        var genericIds = /^(1|2|3|4|5|6|7|8|9|0|test|temp|undefined|null|msg|email|id)$/i;
        if (genericIds.test(trimmedId))
            return 'ID genérico/común';
        if (/^\d{1,6}$/.test(trimmedId))
            return 'UID numérico simple (posible UID de IMAP)';
        if (/^[a-zA-Z]{1,3}$/.test(trimmedId))
            return 'solo letras simples';
        var hasMessageIdFormat = trimmedId.includes('@') ||
            trimmedId.includes('-') ||
            trimmedId.includes('.') ||
            trimmedId.length > 10;
        if (!hasMessageIdFormat)
            return 'sin formato de Message-ID esperado';
        return 'pasó todas las validaciones'; // No debería llegar aquí
    };
    /**
     * Filtra emails enviados para obtener solo los que NO han sido procesados
     * Esta es la función principal de deduplicación para emails enviados
     */
    SentEmailDuplicationService.filterUnprocessedSentEmails = function (emails, siteId) {
        return __awaiter(this, void 0, void 0, function () {
            var unprocessed, alreadyProcessed, debugInfo, i, email, debugItem, standardEmailId, isProcessed, error_1, created, error_2, summary;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        unprocessed = [];
                        alreadyProcessed = [];
                        debugInfo = [];
                        console.log("[SENT_EMAIL_DEDUP] \uD83D\uDD0D Iniciando filtrado de ".concat(emails.length, " emails enviados para site: ").concat(siteId));
                        i = 0;
                        _a.label = 1;
                    case 1:
                        if (!(i < emails.length)) return [3 /*break*/, 9];
                        email = emails[i];
                        debugItem = {
                            index: i,
                            emailTo: email.to,
                            emailSubject: email.subject,
                            emailDate: email.date,
                            rawIds: {
                                messageId: email.messageId,
                                id: email.id,
                                uid: email.uid
                            }
                        };
                        standardEmailId = this.extractStandardEmailId(email);
                        debugItem.standardEmailId = standardEmailId;
                        if (!standardEmailId) {
                            console.log("[SENT_EMAIL_DEDUP] \u26A0\uFE0F Email sin ID v\u00E1lido, incluyendo en unprocessed");
                            debugItem.decision = 'unprocessed_no_id';
                            debugInfo.push(debugItem);
                            unprocessed.push(email);
                            return [3 /*break*/, 8];
                        }
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, SyncedObjectsService_1.SyncedObjectsService.objectIsProcessed(standardEmailId, siteId, 'sent_email')];
                    case 3:
                        isProcessed = _a.sent();
                        debugItem.existsInSyncedObjects = isProcessed;
                        if (isProcessed) {
                            debugItem.decision = 'already_processed_synced_objects';
                            debugInfo.push(debugItem);
                            alreadyProcessed.push(email);
                            return [3 /*break*/, 8];
                        }
                        else {
                        }
                        return [3 /*break*/, 5];
                    case 4:
                        error_1 = _a.sent();
                        console.error("[SENT_EMAIL_DEDUP] \u274C Error verificando en synced_objects para \"".concat(standardEmailId, "\":"), error_1);
                        debugItem.syncedObjectsError = error_1 instanceof Error ? error_1.message : String(error_1);
                        return [3 /*break*/, 5];
                    case 5:
                        _a.trys.push([5, 7, , 8]);
                        return [4 /*yield*/, SyncedObjectsService_1.SyncedObjectsService.createObject({
                                external_id: standardEmailId,
                                site_id: siteId,
                                object_type: 'sent_email',
                                status: 'pending',
                                provider: email.provider || 'unknown',
                                metadata: {
                                    subject: email.subject,
                                    to: email.to,
                                    from: email.from,
                                    date: email.date,
                                    sync_source: 'sent_email_dedup_filter'
                                }
                            })];
                    case 6:
                        created = _a.sent();
                        if (created) {
                            debugItem.decision = 'unprocessed_new';
                            debugInfo.push(debugItem);
                            unprocessed.push(email);
                        }
                        else {
                            debugItem.decision = 'unprocessed_create_failed';
                            debugInfo.push(debugItem);
                            unprocessed.push(email);
                        }
                        return [3 /*break*/, 8];
                    case 7:
                        error_2 = _a.sent();
                        console.error("[SENT_EMAIL_DEDUP] \u274C Error creando registro para \"".concat(standardEmailId, "\":"), error_2);
                        debugItem.createError = error_2 instanceof Error ? error_2.message : String(error_2);
                        debugItem.decision = 'unprocessed_create_error';
                        debugInfo.push(debugItem);
                        unprocessed.push(email);
                        return [3 /*break*/, 8];
                    case 8:
                        i++;
                        return [3 /*break*/, 1];
                    case 9:
                        summary = {
                            total: emails.length,
                            unprocessed: unprocessed.length,
                            alreadyProcessed: alreadyProcessed.length
                        };
                        console.log("[SENT_EMAIL_DEDUP] \uD83D\uDCCA RESUMEN DE FILTRADO:", summary);
                        console.log("[SENT_EMAIL_DEDUP] \u2705 Emails para procesar: ".concat(unprocessed.length));
                        console.log("[SENT_EMAIL_DEDUP] \uD83D\uDD04 Emails ya procesados: ".concat(alreadyProcessed.length));
                        return [2 /*return*/, { unprocessed: unprocessed, alreadyProcessed: alreadyProcessed, debugInfo: debugInfo }];
                }
            });
        });
    };
    /**
     * Marca un email enviado como procesado exitosamente
     */
    SentEmailDuplicationService.markSentEmailAsProcessed = function (email_1, siteId_1) {
        return __awaiter(this, arguments, void 0, function (email, siteId, metadata) {
            var standardEmailId, result, error_3;
            if (metadata === void 0) { metadata = {}; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        standardEmailId = this.extractStandardEmailId(email);
                        if (!standardEmailId) {
                            console.log("[SENT_EMAIL_DEDUP] \u26A0\uFE0F No se puede marcar como procesado, email sin ID v\u00E1lido");
                            return [2 /*return*/, false];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, SyncedObjectsService_1.SyncedObjectsService.updateObject(standardEmailId, siteId, {
                                status: 'processed',
                                metadata: __assign(__assign({}, metadata), { processed_at: new Date().toISOString(), sync_source: 'sent_email_processing' })
                            }, 'sent_email')];
                    case 2:
                        result = _a.sent();
                        if (result) {
                            return [2 /*return*/, true];
                        }
                        else {
                            return [2 /*return*/, false];
                        }
                        return [3 /*break*/, 4];
                    case 3:
                        error_3 = _a.sent();
                        console.error("[SENT_EMAIL_DEDUP] \u274C Error marcando email \"".concat(standardEmailId, "\" como procesado:"), error_3);
                        return [2 /*return*/, false];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Marca un email enviado como error o saltado
     */
    SentEmailDuplicationService.markSentEmailAsError = function (email_1, siteId_1, errorMessage_1) {
        return __awaiter(this, arguments, void 0, function (email, siteId, errorMessage, isSkipped) {
            var standardEmailId, status, result, error_4;
            if (isSkipped === void 0) { isSkipped = false; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        standardEmailId = this.extractStandardEmailId(email);
                        if (!standardEmailId) {
                            return [2 /*return*/, false];
                        }
                        status = isSkipped ? 'skipped' : 'error';
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, SyncedObjectsService_1.SyncedObjectsService.updateObject(standardEmailId, siteId, {
                                status: status,
                                error_message: errorMessage,
                                metadata: {
                                    error_at: new Date().toISOString(),
                                    sync_source: 'sent_email_processing'
                                }
                            }, 'sent_email')];
                    case 2:
                        result = _a.sent();
                        return [2 /*return*/, !!result];
                    case 3:
                        error_4 = _a.sent();
                        console.error("[SENT_EMAIL_DEDUP] \u274C Error marcando email \"".concat(standardEmailId, "\" como ").concat(status, ":"), error_4);
                        return [2 /*return*/, false];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Busca un mensaje existente por ID estándar en la base de datos
     */
    SentEmailDuplicationService.findExistingMessageByStandardId = function (conversationId, leadId, standardEmailId) {
        return __awaiter(this, void 0, void 0, function () {
            var searchQueries, results, _i, results_1, result, foundMessageId, error_5;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!standardEmailId)
                            return [2 /*return*/, null];
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        searchQueries = [
                            // Campo principal actual
                            supabase_client_1.supabaseAdmin
                                .from('messages')
                                .select('id')
                                .eq('conversation_id', conversationId)
                                .eq('lead_id', leadId)
                                .filter('custom_data->>email_id', 'eq', standardEmailId)
                                .limit(1),
                            // Campo en delivery.details (formato actual)
                            supabase_client_1.supabaseAdmin
                                .from('messages')
                                .select('id')
                                .eq('conversation_id', conversationId)
                                .eq('lead_id', leadId)
                                .filter('custom_data->delivery->>details->>api_messageId', 'eq', standardEmailId)
                                .limit(1),
                            // Campo legacy external_message_id
                            supabase_client_1.supabaseAdmin
                                .from('messages')
                                .select('id')
                                .eq('conversation_id', conversationId)
                                .eq('lead_id', leadId)
                                .filter('custom_data->delivery->>external_message_id', 'eq', standardEmailId)
                                .limit(1)
                        ];
                        return [4 /*yield*/, Promise.allSettled(searchQueries)];
                    case 2:
                        results = _a.sent();
                        for (_i = 0, results_1 = results; _i < results_1.length; _i++) {
                            result = results_1[_i];
                            if (result.status === 'fulfilled' && result.value.data && result.value.data.length > 0) {
                                foundMessageId = result.value.data[0].id;
                                return [2 /*return*/, foundMessageId];
                            }
                        }
                        return [2 /*return*/, null];
                    case 3:
                        error_5 = _a.sent();
                        console.error('[SENT_EMAIL_DEDUP] Error buscando por ID estándar:', error_5);
                        return [2 /*return*/, null];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Verificación completa de duplicados para un email enviado
     */
    SentEmailDuplicationService.validateSentEmailForDuplication = function (email, conversationId, leadId) {
        return __awaiter(this, void 0, void 0, function () {
            var standardEmailId, existingMessageId, stableDuplicateCheck, error_6;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        standardEmailId = this.extractStandardEmailId(email);
                        if (!standardEmailId) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.findExistingMessageByStandardId(conversationId, leadId, standardEmailId)];
                    case 1:
                        existingMessageId = _a.sent();
                        if (existingMessageId) {
                            return [2 /*return*/, {
                                    isDuplicate: true,
                                    reason: "Duplicado por ID est\u00E1ndar RFC 5322: \"".concat(standardEmailId, "\""),
                                    existingId: existingMessageId,
                                    emailId: standardEmailId || undefined,
                                    standardId: standardEmailId || undefined
                                }];
                        }
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, stable_email_deduplication_1.StableEmailDeduplicationService.isEmailDuplicateStable(email, conversationId, leadId)];
                    case 3:
                        stableDuplicateCheck = _a.sent();
                        if (stableDuplicateCheck.isDuplicate) {
                            return [2 /*return*/, {
                                    isDuplicate: true,
                                    reason: "Duplicado por fingerprint estable: ".concat(stableDuplicateCheck.reason),
                                    existingId: stableDuplicateCheck.existingMessageId,
                                    emailId: standardEmailId || undefined,
                                    standardId: standardEmailId || undefined
                                }];
                        }
                        return [3 /*break*/, 5];
                    case 4:
                        error_6 = _a.sent();
                        console.warn('[SENT_EMAIL_DEDUP] Error en verificación por fingerprint estable:', error_6);
                        return [3 /*break*/, 5];
                    case 5: 
                    // 3. No es duplicado
                    return [2 /*return*/, {
                            isDuplicate: false,
                            emailId: standardEmailId || undefined,
                            standardId: standardEmailId || undefined
                        }];
                }
            });
        });
    };
    return SentEmailDuplicationService;
}());
exports.SentEmailDuplicationService = SentEmailDuplicationService;
