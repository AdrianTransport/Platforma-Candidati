// Trimitere de email tranzacțional prin Resend (resend.com), folosit pentru
// linkurile de resetare a parolei. Fără cheie configurată, trimiterea este
// dezactivată explicit - nu se preface ca a trimis ceva.

export function mailConfigured(env = process.env) {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL);
}

export async function sendMail({ to, subject, text, html }, env = process.env, fetcher = fetch) {
  if (!mailConfigured(env)) {
    throw new Error('Serviciul de email nu este configurat (RESEND_API_KEY / RESEND_FROM_EMAIL lipsesc).');
  }
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [to],
      subject,
      text,
      html,
    }),
  });
  if (!response.ok) {
    const detalii = await response.text().catch(() => '');
    throw new Error(`Resend a răspuns cu eroare (${response.status}): ${detalii.slice(0, 300)}`);
  }
  return response.json();
}
