export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireValue(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}
export function text(value, name, max = 2000, required = true) {
  if (!required && (value === undefined || value === '')) return '';
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${name}`);
  return value.trim();
}
export function email(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
}
export function sender(value) {
  return typeof value === 'string' && !/[\r\n]/.test(value) && value.length < 320 &&
    (email(value) || /^[^<>]+<[^<>]+>$/.test(value) && email(value.match(/<([^<>]+)>$/)[1]));
}
export const eventTypes = ['rsvp.created', 'message.created', 'song.suggested'];
export function invitationInput(body, fallbackSender) {
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 'Invalid invitation');
  requireValue(typeof body.id === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(body.id), 'Invalid invitation id');
  const name = text(body.name, 'name', 120);
  const from = body.from || fallbackSender;
  requireValue(sender(from), 'A verified Resend sender is required');
  const recipientSource = body.recipientSource || 'service';
  requireValue(['service', 'invitation'].includes(recipientSource), 'Invalid recipient source');
  const recipients = body.recipients || [];
  requireValue(Array.isArray(recipients) && recipients.length >= (recipientSource === 'service' ? 1 : 0) && recipients.length <= 10 && recipients.every(email), 'Use valid organizer email addresses');
  const types = body.events || eventTypes;
  requireValue(Array.isArray(types) && types.length && types.every(t => eventTypes.includes(t)), 'Invalid events');
  return { id: body.id, name, from, recipientSource, recipients: [...new Set(recipients)], events: [...new Set(types)] };
}
export function eventInput(body) {
  requireValue(body && typeof body === 'object' && !Array.isArray(body) && eventTypes.includes(body.type), 'Unsupported event type');
  const recipient = {};
  if (body.organizerEmail !== undefined) {
    requireValue(email(body.organizerEmail), 'Invalid organizer email');
    recipient.organizerEmail = body.organizerEmail;
  }
  const d = body.data;
  requireValue(d && typeof d === 'object' && !Array.isArray(d), 'Invalid event data');
  // Arbitrary recipient/from/HTML fields are never accepted from an invitation.
  const name = text(d.name, 'name', 120);
  const message = text(d.message, 'message', 2000, false);
  if (body.type === 'rsvp.created') {
    requireValue(typeof d.attendingCeremony === 'boolean' && typeof d.attendingParty === 'boolean', 'Invalid attendance');
    const attending = d.attendingCeremony || d.attendingParty;
    requireValue(Number.isInteger(d.passes) && d.passes >= (attending ? 1 : 0) && d.passes <= 100 && (attending || d.passes === 0), 'Invalid passes');
    const contactEmail = text(d.email, 'email', 254, false);
    requireValue(!contactEmail || email(contactEmail), 'Invalid email');
    return { type: body.type, ...recipient, data: { name, message, attendingCeremony: d.attendingCeremony,
      attendingParty: d.attendingParty, passes: d.passes, email: contactEmail,
      phone: text(d.phone, 'phone', 120, false), dietary: text(d.dietary, 'dietary', 2000, false) } };
  }
  if (body.type === 'message.created') {
    requireValue(message.length > 0, 'Message is required');
    return { type: body.type, ...recipient, data: { name, message } };
  }
  return { type: body.type, ...recipient, data: { name, message, songTitle: text(d.songTitle, 'songTitle', 200), artist: text(d.artist, 'artist', 200, false) } };
}
