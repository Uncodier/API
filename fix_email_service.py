import re

with open("src/lib/services/email/EmailService.ts", "r") as f:
    content = f.read()

safe_logout = """
  /**
   * Cierra de forma segura la conexión IMAP usando un timeout para evitar cuelgues.
   * Envía el comando LOGOUT para liberar la conexión en el servidor y prevenir
   * el error "Too many simultaneous connections".
   */
  private static async safeLogout(client: ImapFlow | undefined, contextName: string = ''): Promise<void> {
    if (!client) return;
    
    try {
      // 1. Intentar hacer un logout ordenado con timeout corto
      const logoutPromise = client.logout();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Logout timeout')), 2500);
      });
      
      await Promise.race([logoutPromise, timeoutPromise]);
      if (contextName) console.log(`[EmailService] 👋 Desconectado ordenadamente del servidor IMAP (${contextName})`);
    } catch (e) {
      if (contextName) console.warn(`[EmailService] ⚠️ Error/timeout durante logout IMAP (${contextName}), forzando cierre...`);
      // 2. Si falla o da timeout, forzar cierre del socket
      try {
        if (typeof (client as any).close === 'function') {
          (client as any).close();
        } else if (typeof (client as any).destroy === 'function') {
          (client as any).destroy();
        }
      } catch (closeError) {
        // Ignorar
      }
    }
  }
"""

content = content.replace("export class EmailService {", "export class EmailService {\n" + safe_logout)


# listAllMailboxes
list_all_mailboxes_old = """    } finally {
      if (client) {
        try {
          if (typeof (client as any).close === 'function') (client as any).close();
          else if (typeof (client as any).destroy === 'function') (client as any).destroy();
        } catch {}
      }
    }"""
list_all_mailboxes_new = """    } finally {
      await EmailService.safeLogout(client, 'listAllMailboxes');
    }"""
content = content.replace(list_all_mailboxes_old, list_all_mailboxes_new)

# fetchEmails
fetch_emails_old = """    } finally {
      // Clean up connection - OPTIMIZADO para velocidad máxima
      if (client) {
        try {
          // NO HACER logout() - se cuelga. Forzar cierre directo.

          
          if (typeof (client as any).close === 'function') {
            (client as any).close();
          } else if (typeof (client as any).destroy === 'function') {
            (client as any).destroy();
          }
          

        } catch (closeError) {
          // Ignorar errores de cierre - no es crítico

        }
      }
    }"""
fetch_emails_new = """    } finally {
      await EmailService.safeLogout(client, 'fetchEmails');
    }"""
content = content.replace(fetch_emails_old, fetch_emails_new)


# fetchEmailsInRange
fetch_in_range_old = """    } finally {
      if (client) {
        try {
          if (typeof (client as any).close === 'function') {
            (client as any).close();
          } else if (typeof (client as any).destroy === 'function') {
            (client as any).destroy();
          }
        } catch {}
      }
    }"""
fetch_in_range_new = """    } finally {
      await EmailService.safeLogout(client, 'fetchEmailsInRange');
    }"""
# There are two of these identical blocks, one in fetchEmailsInRange, one in fetchEmailsInRangeFromMailbox.
pieces = content.split(fetch_in_range_old)
if len(pieces) == 3:
    content = pieces[0] + """    } finally {
      await EmailService.safeLogout(client, 'fetchEmailsInRange');
    }""" + pieces[1] + """    } finally {
      await EmailService.safeLogout(client, 'fetchEmailsInRangeFromMailbox');
    }""" + pieces[2]

# deleteEmail
delete_email_old = """    } finally {
      // Clean up connection
      if (client) {
        try {
          await client.logout();
          console.log(`[EmailService] 👋 Desconectado del servidor IMAP (eliminación)`);
        } catch (logoutError) {
          console.warn(`[EmailService] ⚠️ Error durante logout IMAP (eliminación):`, logoutError);
        }
      }
    }"""
delete_email_new = """    } finally {
      await EmailService.safeLogout(client, 'deleteEmail');
    }"""
content = content.replace(delete_email_old, delete_email_new)


# deleteSpecificBounces
delete_bounces_old = """    } finally {
      if (client) {
        try {
          await client.logout();
        } catch (logoutError) {
          // Ignorar errores de logout
        }
      }
    }"""
delete_bounces_new = """    } finally {
      await EmailService.safeLogout(client, 'deleteSpecificBounces');
    }"""
content = content.replace(delete_bounces_old, delete_bounces_new)


# deleteBouncesBySearch
delete_bounces_search_old = """    } finally {
      if (client) {
        try {
          await client.logout();
        } catch (logoutError) {
          console.warn(`[EmailService] ⚠️ Error en logout:`, logoutError);
        }
      }
    }"""
delete_bounces_search_new = """    } finally {
      await EmailService.safeLogout(client, 'deleteBouncesBySearch');
    }"""
content = content.replace(delete_bounces_search_old, delete_bounces_search_new)

# fetchSentEmails
fetch_sent_old = """    } finally {
      // Clean up connection
      if (client) {
        try {
          await client.logout();
          console.log(`[EmailService] 👋 Desconectado del servidor IMAP (emails enviados)`);
        } catch (logoutError) {
          console.warn(`[EmailService] ⚠️ Error durante logout IMAP (emails enviados):`, logoutError);
        }
      }
    }"""
fetch_sent_new = """    } finally {
      await EmailService.safeLogout(client, 'fetchSentEmails');
    }"""
content = content.replace(fetch_sent_old, fetch_sent_new)


with open("src/lib/services/email/EmailService.ts", "w") as f:
    f.write(content)

print("Done")