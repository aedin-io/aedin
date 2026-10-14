// Transactional email via Resend's HTTP API (works from Workers, no SDK).
// Without RESEND_API_KEY (local dev) the message is logged instead of sent.
export interface MailEnv { RESEND_API_KEY?: string; EMAIL_FROM?: string }

export async function sendEmail(env: MailEnv, to: string, subject: string, html: string, text: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[email:dev] to=${to} subject=${subject}\n${text}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM || 'AEDIN <noreply@aedin.io>', to, subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function magicLinkEmail(url: string) {
  return {
    subject: 'Your AEDIN sign-in link',
    text: `Sign in to AEDIN:\n\n${url}\n\nThis link expires in 10 minutes. If you didn't request it, ignore this email.`,
    html: `<p>Sign in to AEDIN:</p><p><a href="${esc(url)}">Sign in</a></p>` +
      `<p style="color:#666;font-size:13px">This link expires in 10 minutes. If you didn't request it, ignore this email.</p>`,
  };
}
