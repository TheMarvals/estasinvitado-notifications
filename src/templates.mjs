const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function renderEmail(invitation, event) {
  const d = event.data;
  const heading = { 'rsvp.created': 'Nueva confirmación de asistencia', 'message.created': 'Un nuevo mensaje', 'song.suggested': 'Una nueva canción' }[event.type];
  const rows = [['Invitado', d.name]];
  if (event.type === 'rsvp.created') rows.push(['Ceremonia', d.attendingCeremony ? 'Sí asistirá' : 'No asistirá'],
    ['Celebración', d.attendingParty ? 'Sí asistirá' : 'No asistirá'], ['Personas en total', d.passes],
    ['Correo', d.email], ['Teléfono', d.phone], ['Alimentación', d.dietary]);
  if (event.type === 'song.suggested') rows.push(['Canción', d.songTitle], ['Artista', d.artist]);
  rows.push(['Mensaje', d.message]);
  const content = rows.filter(([, value]) => value !== '' && value !== undefined);
  return {
    from: invitation.from,
    to: invitation.recipients,
    subject: `${heading} · ${invitation.name}`,
    text: `${invitation.name}\n${heading}\n\n${content.map(([label, value]) => `${label}: ${value}`).join('\n')}`,
    html: `<html lang="es"><body style="margin:0;background:#f7f4eb;color:#303b2b;font-family:Georgia,serif"><div style="max-width:560px;margin:32px auto;padding:32px;background:#fffdf7;border:1px solid #d5cbb3;border-radius:20px"><p style="color:#66734e;font-size:14px">${escape(invitation.name)}</p><h1 style="font-size:28px;font-weight:normal">${heading}</h1><table style="width:100%;border-collapse:collapse">${content.map(([label, value]) => `<tr><th style="text-align:left;vertical-align:top;padding:12px 12px 12px 0;border-bottom:1px solid #e9e2d1;font-size:14px">${label}</th><td style="padding:12px 0;border-bottom:1px solid #e9e2d1;white-space:pre-wrap;overflow-wrap:anywhere">${escape(value)}</td></tr>`).join('')}</table></div></body></html>`,
  };
}
