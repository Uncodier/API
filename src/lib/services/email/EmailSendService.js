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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailSendService = void 0;
var EmailConfigService_1 = require("./EmailConfigService");
var SentEmailDuplicationService_1 = require("./SentEmailDuplicationService");
var nodemailer_1 = __importDefault(require("nodemailer"));
var supabase_client_1 = require("@/lib/database/supabase-client");
var EmailTrackingService_1 = require("../tracking/EmailTrackingService");
var EmailSendService = /** @class */ (function () {
    function EmailSendService() {
    }
    /**
     * Envía un email usando la configuración SMTP del sitio
     */
    EmailSendService.sendEmail = function (params) {
        return __awaiter(this, void 0, void 0, function () {
            var email, from, fromEmail, subject, message, signatureHtml, agent_id, conversation_id, lead_id, site_id, trackingId, siteInfo, emailConfig, senderEmail, transporter, htmlContent, fromName, fromAddress, mailOptions, info, sentAt, envelopeData, envelopeId, configError_1, isConfigError;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        email = params.email, from = params.from, fromEmail = params.fromEmail, subject = params.subject, message = params.message, signatureHtml = params.signatureHtml, agent_id = params.agent_id, conversation_id = params.conversation_id, lead_id = params.lead_id, site_id = params.site_id, trackingId = params.trackingId;
                        // Si el email es el temporal, no enviar email real
                        if (email === 'no-email@example.com') {
                            console.log('📧 Email temporal detectado, no se enviará email real:', {
                                to: email,
                                from: from || 'AI Assistant',
                                fromEmail: fromEmail,
                                subject: subject,
                                messagePreview: message.substring(0, 100) + '...'
                            });
                            return [2 /*return*/, {
                                    success: true,
                                    email_id: "temp-".concat(Date.now()),
                                    recipient: email,
                                    sender: fromEmail || from,
                                    subject: subject,
                                    message_preview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
                                    sent_at: new Date().toISOString(),
                                    status: 'skipped',
                                    reason: 'Temporary email address - no real email sent'
                                }];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 5, , 6]);
                        return [4 /*yield*/, this.getSiteInfo(site_id)];
                    case 2:
                        siteInfo = _a.sent();
                        return [4 /*yield*/, EmailConfigService_1.EmailConfigService.getEmailConfig(site_id)];
                    case 3:
                        emailConfig = _a.sent();
                        senderEmail = fromEmail || emailConfig.user || emailConfig.email;
                        if (!senderEmail) {
                            throw new Error('No se pudo determinar el email del remitente');
                        }
                        transporter = nodemailer_1.default.createTransport({
                            host: emailConfig.smtpHost,
                            port: emailConfig.smtpPort,
                            secure: emailConfig.smtpPort === 465, // true para puerto 465, false para otros puertos
                            auth: {
                                user: emailConfig.user || emailConfig.email,
                                pass: emailConfig.password,
                            },
                            tls: {
                                rejectUnauthorized: false // Para evitar problemas con certificados auto-firmados
                            }
                        });
                        htmlContent = this.buildHtmlContent(message, siteInfo, signatureHtml);
                        // Inyectar rastreo si se proporciona trackingId
                        if (params.trackingId) {
                            console.log("[EMAIL_SEND] \uD83C\uDFAF Inyectando rastreo con trackingId: ".concat(params.trackingId));
                            htmlContent = EmailTrackingService_1.EmailTrackingService.injectTracking(htmlContent, params.trackingId);
                        }
                        fromName = from || 'AI Assistant';
                        fromAddress = senderEmail;
                        mailOptions = {
                            from: "".concat(fromName, " <").concat(fromAddress, ">"),
                            to: email,
                            subject: subject,
                            html: htmlContent,
                            text: message.replace(/<[^>]+>/g, ''), // Asegurar versión de texto plano limpia
                            replyTo: fromAddress
                        };
                        return [4 /*yield*/, transporter.sendMail(mailOptions)];
                    case 4:
                        info = _a.sent();
                        console.log('✅ Email enviado exitosamente:', {
                            messageId: info.messageId,
                            to: email,
                            from: "".concat(fromName, " <").concat(fromAddress, ">"),
                            subject: subject
                        });
                        // Log del email enviado (se guarda automáticamente en Vercel/Supabase)
                        console.log('📧 Email enviado - Detalles:', {
                            recipient_email: email,
                            sender_email: fromAddress,
                            subject: subject,
                            message_preview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
                            agent_id: agent_id,
                            conversation_id: conversation_id,
                            lead_id: lead_id,
                            smtp_message_id: info.messageId,
                            sent_at: new Date().toISOString()
                        });
                        sentAt = new Date().toISOString();
                        envelopeData = {
                            to: email,
                            from: "".concat(fromName, " <").concat(fromAddress, ">"),
                            subject: subject,
                            date: sentAt
                        };
                        envelopeId = SentEmailDuplicationService_1.SentEmailDuplicationService.generateEnvelopeBasedId(envelopeData);
                        console.log("[EMAIL_SEND] \uD83C\uDFD7\uFE0F Envelope ID generado para correlaci\u00F3n: \"".concat(envelopeId, "\""));
                        return [2 /*return*/, {
                                success: true,
                                email_id: info.messageId,
                                envelope_id: envelopeId || undefined, // Convertir null a undefined
                                recipient: email,
                                sender: "".concat(fromName, " <").concat(fromAddress, ">"),
                                subject: subject,
                                message_preview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
                                sent_at: sentAt,
                                status: 'sent'
                            }];
                    case 5:
                        configError_1 = _a.sent();
                        console.error('Error obteniendo configuración de email o enviando email:', configError_1);
                        isConfigError = configError_1 instanceof Error && (configError_1.message.includes('settings') ||
                            configError_1.message.includes('token') ||
                            configError_1.message.includes('Site settings not found') ||
                            configError_1.message.includes('No se encontró token de email'));
                        return [2 /*return*/, {
                                success: false,
                                error: {
                                    code: isConfigError ? 'EMAIL_CONFIG_NOT_FOUND' : 'EMAIL_SEND_FAILED',
                                    message: isConfigError
                                        ? "Email configuration not found for site ".concat(site_id, ". Please configure email settings and store email token using /api/secure-tokens endpoint.")
                                        : configError_1 instanceof Error ? configError_1.message : 'Failed to send email'
                                }
                            }];
                    case 6: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Obtiene información del sitio desde la base de datos
     */
    EmailSendService.getSiteInfo = function (siteId) {
        return __awaiter(this, void 0, void 0, function () {
            var _a, site, error, error_1;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, supabase_client_1.supabaseAdmin
                                .from('sites')
                                .select('name, url')
                                .eq('id', siteId)
                                .single()];
                    case 1:
                        _a = _b.sent(), site = _a.data, error = _a.error;
                        if (error || !site) {
                            console.warn("No se pudo obtener informaci\u00F3n del sitio ".concat(siteId, ", usando valores por defecto"));
                            return [2 /*return*/, { name: 'Nuestro sitio' }];
                        }
                        return [2 /*return*/, {
                                name: site.name || 'Nuestro sitio',
                                url: site.url
                            }];
                    case 2:
                        error_1 = _b.sent();
                        console.warn("Error obteniendo informaci\u00F3n del sitio ".concat(siteId, ":"), error_1);
                        return [2 /*return*/, { name: 'Nuestro sitio' }];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Construye el contenido HTML del email
     */
    EmailSendService.buildHtmlContent = function (message, siteInfo, signatureHtml) {
        var isHtml = /<(html|body|table|tbody|tr|td|div|p)\b/i.test(message);
        var htmlContent = isHtml ? message : this.renderMessageWithLists(message);
        // Si el contenido ya era HTML, no lo envolvemos en el div predeterminado para evitar romper diseños,
        // a menos que queramos inyectar la firma. Para asegurar que la firma se agregue bien, lo envolvemos.
        return "\n      <div style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;\">\n        <div style=\"line-height: 1.6; font-size: 16px;\">\n          ".concat(htmlContent, "\n        </div>\n        ").concat(signatureHtml ? "<div style=\"margin-top: 20px; font-size: 14px; color: #666;\">".concat(signatureHtml, "</div>") : '', "\n      </div>\n    ");
    };
    /**
     * Escapa caracteres HTML especiales para prevenir inyección y preservar texto
     */
    EmailSendService.escapeHtml = function (input) {
        return input
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };
    /**
     * Escapa caracteres para su uso en atributos HTML (como href, src, etc)
     * Se incluye el escape de '&' para cumplir con el estándar HTML en atributos.
     */
    EmailSendService.escapeAttr = function (input) {
        return input
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    };
    /**
     * Convierte texto plano a HTML con soporte para listas con -, *, • y 1. 2.
     */
    EmailSendService.renderMessageWithLists = function (message) {
        var _a, _b, _c, _d, _e;
        var lines = message.split('\n');
        var htmlParts = [];
        var isBullet = function (line) { return /^\s*(?:[-*•]\s+)/.test(line); };
        var isNumbered = function (line) { return /^\s*\d+[\.)]\s+/.test(line); };
        // Apply inline markdown before parsing blocks
        var applyInlineMarkdown = function (text) {
            // Escapar < solo si no parece ser el inicio de un tag HTML para permitir tags mezclados con markdown
            var html = text.replace(/<(?![a-z/])/gi, '&lt;');
            // Images: ![alt](url)
            html = html.replace(/!\[(.*?)\]\((.*?)\)/g, '<br/><img src="$2" alt="$1" style="max-width: 100%; border-radius: 8px; margin: 16px 0;" /><br/>');
            // Links: [text](url)
            html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" style="color: #0066cc; text-decoration: underline;">$1</a>');
            // Bold
            html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
            // Italic
            html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
            html = html.replace(/_(.*?)_/g, '<em>$1</em>');
            return html;
        };
        var i = 0;
        while (i < lines.length) {
            var raw = (_a = lines[i]) !== null && _a !== void 0 ? _a : '';
            var line = raw.trimEnd();
            // Bloque de lista con viñetas
            if (isBullet(line)) {
                var items = [];
                while (i < lines.length && isBullet(((_b = lines[i]) !== null && _b !== void 0 ? _b : '').trimEnd())) {
                    var itemText = ((_c = lines[i]) !== null && _c !== void 0 ? _c : '')
                        .replace(/^\s*[-*•]\s+/, '')
                        .trim();
                    items.push("<li style=\"margin: 4px 0;\">".concat(applyInlineMarkdown(itemText), "</li>"));
                    i++;
                }
                htmlParts.push("<ul style=\"margin: 0 0 16px 20px; padding-left: 18px; list-style-type: disc;\">".concat(items.join(''), "</ul>"));
                continue;
            }
            // Bloque de lista numerada
            if (isNumbered(line)) {
                var items = [];
                while (i < lines.length && isNumbered(((_d = lines[i]) !== null && _d !== void 0 ? _d : '').trimEnd())) {
                    var itemText = ((_e = lines[i]) !== null && _e !== void 0 ? _e : '')
                        .replace(/^\s*\d+[\.)]\s+/, '')
                        .trim();
                    items.push("<li style=\"margin: 4px 0;\">".concat(applyInlineMarkdown(itemText), "</li>"));
                    i++;
                }
                htmlParts.push("<ol style=\"margin: 0 0 16px 20px; padding-left: 18px; list-style-type: decimal;\">".concat(items.join(''), "</ol>"));
                continue;
            }
            // Línea vacía -> salto visual
            if (line.trim().length === 0) {
                htmlParts.push('<br>');
                i++;
                continue;
            }
            // Párrafo normal
            htmlParts.push("<p style=\"margin: 0 0 16px 0;\">".concat(applyInlineMarkdown(line.trim()), "</p>"));
            i++;
        }
        return htmlParts.join('');
    };
    /**
     * Valida el formato de email
     */
    EmailSendService.isValidEmail = function (email) {
        var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    };
    return EmailSendService;
}());
exports.EmailSendService = EmailSendService;
