"use strict";
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
exports.EmailConfigService = void 0;
var supabase_client_1 = require("@/lib/database/supabase-client");
var token_decryption_1 = require("@/lib/utils/token-decryption");
var EmailConfigService = /** @class */ (function () {
    function EmailConfigService() {
    }
    /**
     * Obtiene la configuración de email para un sitio
     */
    EmailConfigService.getEmailConfig = function (siteId) {
        return __awaiter(this, void 0, void 0, function () {
            var _a, settings, settingsError, tokenValue, aliases, parsedValue, error_1;
            var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6;
            return __generator(this, function (_7) {
                switch (_7.label) {
                    case 0:
                        _7.trys.push([0, 3, , 4]);
                        return [4 /*yield*/, supabase_client_1.supabaseAdmin
                                .from('settings')
                                .select('channels')
                                .eq('site_id', siteId)
                                .single()];
                    case 1:
                        _a = _7.sent(), settings = _a.data, settingsError = _a.error;
                        if (settingsError) {
                            throw new Error("Failed to retrieve site settings: ".concat(settingsError.message));
                        }
                        if (!settings) {
                            throw new Error("Site settings not found for site ".concat(siteId));
                        }
                        return [4 /*yield*/, this.getEmailToken(siteId)];
                    case 2:
                        tokenValue = _7.sent();
                        if (!tokenValue) {
                            throw new Error("No se encontr\u00F3 token de email para el sitio ".concat(siteId, ". Por favor almacena un token de email usando el endpoint /api/secure-tokens"));
                        }
                        aliases = ((_c = (_b = settings.channels) === null || _b === void 0 ? void 0 : _b.email) === null || _c === void 0 ? void 0 : _c.aliases) || null;
                        try {
                            parsedValue = JSON.parse(tokenValue);
                            if (parsedValue.password) {
                                return [2 /*return*/, {
                                        user: parsedValue.email || parsedValue.user || ((_e = (_d = settings.channels) === null || _d === void 0 ? void 0 : _d.email) === null || _e === void 0 ? void 0 : _e.email),
                                        email: parsedValue.email || parsedValue.user || ((_g = (_f = settings.channels) === null || _f === void 0 ? void 0 : _f.email) === null || _g === void 0 ? void 0 : _g.email),
                                        password: parsedValue.password,
                                        host: parsedValue.host || parsedValue.imapHost || ((_j = (_h = settings.channels) === null || _h === void 0 ? void 0 : _h.email) === null || _j === void 0 ? void 0 : _j.incomingServer) || 'imap.gmail.com',
                                        imapHost: parsedValue.imapHost || parsedValue.host || ((_l = (_k = settings.channels) === null || _k === void 0 ? void 0 : _k.email) === null || _l === void 0 ? void 0 : _l.incomingServer) || 'imap.gmail.com',
                                        imapPort: parsedValue.imapPort || parsedValue.port || ((_o = (_m = settings.channels) === null || _m === void 0 ? void 0 : _m.email) === null || _o === void 0 ? void 0 : _o.incomingPort) || 993,
                                        smtpHost: parsedValue.smtpHost || parsedValue.host || ((_q = (_p = settings.channels) === null || _p === void 0 ? void 0 : _p.email) === null || _q === void 0 ? void 0 : _q.outgoingServer) || 'smtp.gmail.com',
                                        smtpPort: parsedValue.smtpPort || ((_s = (_r = settings.channels) === null || _r === void 0 ? void 0 : _r.email) === null || _s === void 0 ? void 0 : _s.outgoingPort) || 587,
                                        tls: true,
                                        aliases: aliases
                                    }];
                            }
                        }
                        catch (jsonError) {
                            // Si no es JSON, usar como contraseña directa
                            return [2 /*return*/, {
                                    user: (_u = (_t = settings.channels) === null || _t === void 0 ? void 0 : _t.email) === null || _u === void 0 ? void 0 : _u.email,
                                    email: (_w = (_v = settings.channels) === null || _v === void 0 ? void 0 : _v.email) === null || _w === void 0 ? void 0 : _w.email,
                                    password: tokenValue,
                                    host: ((_y = (_x = settings.channels) === null || _x === void 0 ? void 0 : _x.email) === null || _y === void 0 ? void 0 : _y.incomingServer) || 'imap.gmail.com',
                                    imapHost: ((_0 = (_z = settings.channels) === null || _z === void 0 ? void 0 : _z.email) === null || _0 === void 0 ? void 0 : _0.incomingServer) || 'imap.gmail.com',
                                    imapPort: ((_2 = (_1 = settings.channels) === null || _1 === void 0 ? void 0 : _1.email) === null || _2 === void 0 ? void 0 : _2.incomingPort) || 993,
                                    smtpHost: ((_4 = (_3 = settings.channels) === null || _3 === void 0 ? void 0 : _3.email) === null || _4 === void 0 ? void 0 : _4.outgoingServer) || 'smtp.gmail.com',
                                    smtpPort: ((_6 = (_5 = settings.channels) === null || _5 === void 0 ? void 0 : _5.email) === null || _6 === void 0 ? void 0 : _6.outgoingPort) || 587,
                                    tls: true,
                                    aliases: aliases
                                }];
                        }
                        throw new Error("El token de email no contiene una contraseña");
                    case 3:
                        error_1 = _7.sent();
                        throw error_1;
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Obtiene y desencripta el token de email
     */
    EmailConfigService.getEmailToken = function (siteId) {
        return __awaiter(this, void 0, void 0, function () {
            var settings, email, query, withIdentifier, decryptedToken, withoutIdentifier, decryptedToken, error_2;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        _c.trys.push([0, 5, , 6]);
                        return [4 /*yield*/, supabase_client_1.supabaseAdmin
                                .from('settings')
                                .select('channels')
                                .eq('site_id', siteId)
                                .single()];
                    case 1:
                        settings = (_c.sent()).data;
                        email = (_b = (_a = settings === null || settings === void 0 ? void 0 : settings.channels) === null || _a === void 0 ? void 0 : _a.email) === null || _b === void 0 ? void 0 : _b.email;
                        query = supabase_client_1.supabaseAdmin
                            .from('secure_tokens')
                            .select('*')
                            .eq('site_id', siteId)
                            .eq('token_type', 'email');
                        if (!email) return [3 /*break*/, 3];
                        return [4 /*yield*/, query.eq('identifier', email).maybeSingle()];
                    case 2:
                        withIdentifier = (_c.sent()).data;
                        if (withIdentifier === null || withIdentifier === void 0 ? void 0 : withIdentifier.encrypted_value) {
                            console.log("[EmailConfigService] \u2705 Token encontrado con identifier, desencriptando localmente...");
                            decryptedToken = this.decryptToken(withIdentifier.encrypted_value);
                            if (decryptedToken) {
                                return [2 /*return*/, decryptedToken];
                            }
                            console.log("[EmailConfigService] \u26A0\uFE0F Desencriptaci\u00F3n local fall\u00F3, intentando sin identifier...");
                        }
                        _c.label = 3;
                    case 3: return [4 /*yield*/, query.maybeSingle()];
                    case 4:
                        withoutIdentifier = (_c.sent()).data;
                        if (withoutIdentifier === null || withoutIdentifier === void 0 ? void 0 : withoutIdentifier.encrypted_value) {
                            console.log("[EmailConfigService] \u2705 Token encontrado sin identifier, desencriptando localmente...");
                            decryptedToken = this.decryptToken(withoutIdentifier.encrypted_value);
                            if (decryptedToken) {
                                return [2 /*return*/, decryptedToken];
                            }
                            console.log("[EmailConfigService] \u26A0\uFE0F Desencriptaci\u00F3n local fall\u00F3");
                        }
                        console.log("[EmailConfigService] \u274C No se pudo obtener token de ninguna fuente");
                        return [2 /*return*/, null];
                    case 5:
                        error_2 = _c.sent();
                        console.error("[EmailConfigService] \u274C Error obteniendo token:", error_2);
                        return [2 /*return*/, null];
                    case 6: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Desencripta un token usando la utilidad compartida de desencriptación
     */
    EmailConfigService.decryptToken = function (encryptedValue) {
        return (0, token_decryption_1.decryptToken)(encryptedValue);
    };
    return EmailConfigService;
}());
exports.EmailConfigService = EmailConfigService;
