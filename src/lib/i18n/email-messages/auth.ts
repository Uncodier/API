import type { EmailLocale } from '../email-locale';
import type { MessageDict } from './index';
import { pickMessage } from './index';

const en: MessageDict = {
  'auth.signup.subject': 'Confirm your signup',
  'auth.signup.title': 'Confirm your email',
  'auth.signup.body': 'Thanks for signing up. Confirm your email with the link below, or enter the code.',
  'auth.signup.cta': 'Confirm email',
  'auth.invite.subject': 'You have been invited',
  'auth.invite.title': 'You are invited',
  'auth.invite.body': 'You have been invited to join. Accept with the link below, or enter the code.',
  'auth.invite.cta': 'Accept invite',
  'auth.magiclink.subject': 'Your sign-in link',
  'auth.magiclink.title': 'Sign in',
  'auth.magiclink.body': 'Use the button below to sign in, or enter the code in the app.',
  'auth.magiclink.cta': 'Sign in',
  'auth.recovery.subject': 'Reset your password',
  'auth.recovery.title': 'Reset your password',
  'auth.recovery.body': 'Reset your password with the link below, or enter the code.',
  'auth.recovery.cta': 'Reset password',
  'auth.email_change.subject': 'Confirm email change',
  'auth.email_change.title': 'Confirm email change',
  'auth.email_change.body': 'Confirm your email change with the link below, or enter the code.',
  'auth.email_change.cta': 'Confirm change',
  'auth.reauthentication.subject': 'Your verification code',
  'auth.reauthentication.title': 'Verification code',
  'auth.reauthentication.body': 'Use this code to verify your identity.',
  'auth.reauthentication.cta': 'Verify',
  'auth.or_enter_code': 'Or enter this code:',
  'auth.code_expires': 'This code expires soon. If you did not request this, you can ignore this email.',
  'auth.footer': 'If the button does not work, copy and paste the link into your browser.',
};

const es: MessageDict = {
  'auth.signup.subject': 'Confirma tu registro',
  'auth.signup.title': 'Confirma tu correo',
  'auth.signup.body': 'Gracias por registrarte. Confirma tu correo con el enlace o introduce el código.',
  'auth.signup.cta': 'Confirmar correo',
  'auth.invite.subject': 'Has sido invitado',
  'auth.invite.title': 'Estás invitado',
  'auth.invite.body': 'Has sido invitado a unirte. Acepta con el enlace o introduce el código.',
  'auth.invite.cta': 'Aceptar invitación',
  'auth.magiclink.subject': 'Tu enlace de acceso',
  'auth.magiclink.title': 'Iniciar sesión',
  'auth.magiclink.body': 'Usa el botón para iniciar sesión, o introduce el código en la app.',
  'auth.magiclink.cta': 'Iniciar sesión',
  'auth.recovery.subject': 'Restablece tu contraseña',
  'auth.recovery.title': 'Restablecer contraseña',
  'auth.recovery.body': 'Restablece tu contraseña con el enlace o introduce el código.',
  'auth.recovery.cta': 'Restablecer contraseña',
  'auth.email_change.subject': 'Confirma el cambio de correo',
  'auth.email_change.title': 'Confirmar cambio de correo',
  'auth.email_change.body': 'Confirma el cambio de correo con el enlace o introduce el código.',
  'auth.email_change.cta': 'Confirmar cambio',
  'auth.reauthentication.subject': 'Tu código de verificación',
  'auth.reauthentication.title': 'Código de verificación',
  'auth.reauthentication.body': 'Usa este código para verificar tu identidad.',
  'auth.reauthentication.cta': 'Verificar',
  'auth.or_enter_code': 'O introduce este código:',
  'auth.code_expires': 'Este código caduca pronto. Si no solicitaste esto, ignora este correo.',
  'auth.footer': 'Si el botón no funciona, copia y pega el enlace en tu navegador.',
};

const fr: MessageDict = {
  'auth.signup.subject': 'Confirmez votre inscription',
  'auth.signup.title': 'Confirmez votre e-mail',
  'auth.signup.body': 'Merci de vous être inscrit. Confirmez votre e-mail avec le lien ou saisissez le code.',
  'auth.signup.cta': 'Confirmer l\'e-mail',
  'auth.invite.subject': 'Vous avez été invité',
  'auth.invite.title': 'Invitation',
  'auth.invite.body': 'Vous avez été invité. Acceptez avec le lien ou saisissez le code.',
  'auth.invite.cta': 'Accepter l\'invitation',
  'auth.magiclink.subject': 'Votre lien de connexion',
  'auth.magiclink.title': 'Connexion',
  'auth.magiclink.body': 'Utilisez le bouton pour vous connecter, ou saisissez le code dans l\'application.',
  'auth.magiclink.cta': 'Se connecter',
  'auth.recovery.subject': 'Réinitialisez votre mot de passe',
  'auth.recovery.title': 'Réinitialiser le mot de passe',
  'auth.recovery.body': 'Réinitialisez votre mot de passe avec le lien ou saisissez le code.',
  'auth.recovery.cta': 'Réinitialiser',
  'auth.email_change.subject': 'Confirmez le changement d\'e-mail',
  'auth.email_change.title': 'Confirmer le changement d\'e-mail',
  'auth.email_change.body': 'Confirmez le changement d\'e-mail avec le lien ou saisissez le code.',
  'auth.email_change.cta': 'Confirmer',
  'auth.reauthentication.subject': 'Votre code de vérification',
  'auth.reauthentication.title': 'Code de vérification',
  'auth.reauthentication.body': 'Utilisez ce code pour vérifier votre identité.',
  'auth.reauthentication.cta': 'Vérifier',
  'auth.or_enter_code': 'Ou saisissez ce code :',
  'auth.code_expires': 'Ce code expire bientôt. Si vous n\'avez pas fait cette demande, ignorez cet e-mail.',
  'auth.footer': 'Si le bouton ne fonctionne pas, copiez-collez le lien dans votre navigateur.',
};

const de: MessageDict = {
  'auth.signup.subject': 'Bestätigen Sie Ihre Anmeldung',
  'auth.signup.title': 'E-Mail bestätigen',
  'auth.signup.body': 'Danke für Ihre Anmeldung. Bestätigen Sie Ihre E-Mail über den Link oder geben Sie den Code ein.',
  'auth.signup.cta': 'E-Mail bestätigen',
  'auth.invite.subject': 'Sie wurden eingeladen',
  'auth.invite.title': 'Einladung',
  'auth.invite.body': 'Sie wurden eingeladen. Nehmen Sie über den Link an oder geben Sie den Code ein.',
  'auth.invite.cta': 'Einladung annehmen',
  'auth.magiclink.subject': 'Ihr Anmeldelink',
  'auth.magiclink.title': 'Anmelden',
  'auth.magiclink.body': 'Nutzen Sie den Button zum Anmelden oder geben Sie den Code in der App ein.',
  'auth.magiclink.cta': 'Anmelden',
  'auth.recovery.subject': 'Passwort zurücksetzen',
  'auth.recovery.title': 'Passwort zurücksetzen',
  'auth.recovery.body': 'Setzen Sie Ihr Passwort über den Link zurück oder geben Sie den Code ein.',
  'auth.recovery.cta': 'Passwort zurücksetzen',
  'auth.email_change.subject': 'E-Mail-Änderung bestätigen',
  'auth.email_change.title': 'E-Mail-Änderung bestätigen',
  'auth.email_change.body': 'Bestätigen Sie die E-Mail-Änderung über den Link oder geben Sie den Code ein.',
  'auth.email_change.cta': 'Änderung bestätigen',
  'auth.reauthentication.subject': 'Ihr Bestätigungscode',
  'auth.reauthentication.title': 'Bestätigungscode',
  'auth.reauthentication.body': 'Verwenden Sie diesen Code zur Identitätsprüfung.',
  'auth.reauthentication.cta': 'Bestätigen',
  'auth.or_enter_code': 'Oder geben Sie diesen Code ein:',
  'auth.code_expires': 'Dieser Code läuft bald ab. Wenn Sie dies nicht angefordert haben, ignorieren Sie diese E-Mail.',
  'auth.footer': 'Wenn der Button nicht funktioniert, kopieren Sie den Link in Ihren Browser.',
};

const ja: MessageDict = {
  'auth.signup.subject': '登録を確認してください',
  'auth.signup.title': 'メールを確認',
  'auth.signup.body': 'ご登録ありがとうございます。下のリンクで確認するか、コードを入力してください。',
  'auth.signup.cta': 'メールを確認',
  'auth.invite.subject': '招待が届いています',
  'auth.invite.title': '招待',
  'auth.invite.body': '招待されています。リンクで承諾するか、コードを入力してください。',
  'auth.invite.cta': '招待を承諾',
  'auth.magiclink.subject': 'サインイン用リンク',
  'auth.magiclink.title': 'サインイン',
  'auth.magiclink.body': '下のボタンでサインインするか、アプリにコードを入力してください。',
  'auth.magiclink.cta': 'サインイン',
  'auth.recovery.subject': 'パスワードをリセット',
  'auth.recovery.title': 'パスワードをリセット',
  'auth.recovery.body': 'リンクでパスワードをリセットするか、コードを入力してください。',
  'auth.recovery.cta': 'パスワードをリセット',
  'auth.email_change.subject': 'メール変更の確認',
  'auth.email_change.title': 'メール変更の確認',
  'auth.email_change.body': 'リンクでメール変更を確認するか、コードを入力してください。',
  'auth.email_change.cta': '変更を確認',
  'auth.reauthentication.subject': '認証コード',
  'auth.reauthentication.title': '認証コード',
  'auth.reauthentication.body': '本人確認のため、このコードを入力してください。',
  'auth.reauthentication.cta': '確認',
  'auth.or_enter_code': 'または、このコードを入力：',
  'auth.code_expires': 'このコードはまもなく期限切れになります。心当たりがない場合はこのメールを無視してください。',
  'auth.footer': 'ボタンが動作しない場合は、リンクをブラウザに貼り付けてください。',
};

export const AUTH_EMAIL_MESSAGES: Partial<Record<EmailLocale, MessageDict>> = { en, es, fr, de, ja };

export type AuthEmailActionType =
  | 'signup'
  | 'invite'
  | 'magiclink'
  | 'recovery'
  | 'email_change'
  | 'reauthentication';

export function authT(
  locale: EmailLocale,
  key: string,
  vars?: Record<string, string | number | undefined | null>
): string {
  return pickMessage(AUTH_EMAIL_MESSAGES, locale, key, vars);
}

export function authActionKeys(action: string): {
  subject: string;
  title: string;
  body: string;
  cta: string;
} {
  const normalized = (['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'reauthentication'].includes(action)
    ? action
    : 'magiclink') as AuthEmailActionType;
  return {
    subject: `auth.${normalized}.subject`,
    title: `auth.${normalized}.title`,
    body: `auth.${normalized}.body`,
    cta: `auth.${normalized}.cta`,
  };
}
