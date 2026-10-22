export interface ImportedClient {
  name: string
  phone: string
  email: string
  notes: string
}

export const MAX_IMPORT_CLIENTS = 5000
export const IMPORT_BATCH_SIZE = 200

export function phoneKey(phone: string): string {
  return phone.replace(/\D/g, '').replace(/^00/, '')
}

export function clientKeys(client: Pick<ImportedClient, 'phone' | 'email'>): string[] {
  const phone = phoneKey(client.phone)
  return [phone ? `p:${phone}` : '', client.email.trim() ? `e:${client.email.trim().toLowerCase()}` : ''].filter(Boolean)
}

export function uniqueClients(rows: ImportedClient[]) {
  const seen = new Set<string>()
  let skipped = 0
  const clients = rows.filter(row => {
    const keys = clientKeys(row)
    if (!row.name.trim() || keys.some(key => seen.has(key))) { skipped++; return false }
    keys.forEach(key => seen.add(key))
    return true
  })
  return { clients, skipped }
}

export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  text = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++ }
      else quoted = !quoted
    } else if (!quoted && (ch === delimiter || ch === '\n' || ch === '\r')) {
      row.push(field.trim()); field = ''
      if (ch !== delimiter) {
        if (row.some(Boolean)) rows.push(row)
        row = []
        if (ch === '\r' && text[i + 1] === '\n') i++
      }
    } else field += ch
  }
  if (quoted) throw new Error('Unclosed quote in CSV file.')
  row.push(field.trim())
  if (row.some(Boolean)) rows.push(row)
  return rows
}

export function matrixToClients(matrix: string[][]): ImportedClient[] {
  if (matrix.length < 2) throw new Error('No contacts found in this table.')
  const headers = matrix[0].map(h => h.toLowerCase().replace(/[\s_-]+/g, ' ').trim())
  const column = (names: string[]) => names.map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1
  const full = column(['name', 'full name', 'client name', 'customer name', 'contact name', 'имя', 'фио', 'nome', 'nombre'])
  const first = column(['first name', 'given name', 'имя клиента'])
  const last = column(['last name', 'family name', 'фамилия'])
  const phone = column(['phone', 'mobile', 'cell', 'telephone', 'tel', 'number', 'phone number', 'mobile phone', 'phone 1 value', 'телефон', 'мобильный', 'telefone', 'teléfono'])
  const email = column(['email', 'e mail', 'email address', 'e mail 1 value', 'email 1 value', 'почта', 'электронная почта'])
  const notes = column(['notes', 'note', 'comments', 'comment', 'memo', 'заметки', 'примечание'])
  if (full < 0 && first < 0 && last < 0) throw new Error('Name column not found. Use name, phone, email, notes as column headings.')
  return matrix.slice(1).map(row => ({
    name: full >= 0 ? (row[full] ?? '') : [row[first], row[last]].filter(Boolean).join(' '),
    phone: row[phone] ?? '', email: row[email] ?? '', notes: row[notes] ?? '',
  }))
}

export function parseClientsCsv(text: string): ImportedClient[] {
  const candidates = [',', ';', '\t'].map(separator => parseDelimited(text, separator))
  candidates.sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))
  return matrixToClients(candidates[0])
}

function unescapeVcard(value: string) {
  return value.replace(/\\([nN,;\\])/g, (_, ch: string) => /n/i.test(ch) ? '\n' : ch)
}

function vcardValue(params: string, value: string) {
  if (/ENCODING=QUOTED-PRINTABLE/i.test(params)) {
    const bytes: number[] = []
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '=' && /^[a-f\d]{2}$/i.test(value.slice(i + 1, i + 3))) {
        bytes.push(parseInt(value.slice(i + 1, i + 3), 16)); i += 2
      } else bytes.push(...new TextEncoder().encode(value[i]))
    }
    const charset = params.match(/CHARSET="?([^;" ]+)/i)?.[1] ?? 'utf-8'
    try { value = new TextDecoder(charset).decode(new Uint8Array(bytes)) }
    catch { value = new TextDecoder().decode(new Uint8Array(bytes)) }
  }
  return unescapeVcard(value).trim()
}

export function parseVcard(text: string): ImportedClient[] {
  const lines: string[] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    const previous = lines[lines.length - 1]
    if (previous && /ENCODING=QUOTED-PRINTABLE/i.test(previous) && previous.endsWith('=')) lines[lines.length - 1] = previous.slice(0, -1) + line.replace(/^[ \t]/, '')
    else if (/^[ \t]/.test(line) && previous) lines[lines.length - 1] += line.slice(1)
    else lines.push(line)
  }
  const clients: ImportedClient[] = []
  let contact: ImportedClient | null = null
  let fallbackName = ''
  for (const line of lines) {
    if (/^BEGIN:VCARD$/i.test(line)) { contact = { name: '', phone: '', email: '', notes: '' }; fallbackName = ''; continue }
    if (/^END:VCARD$/i.test(line)) {
      if (contact) { contact.name ||= fallbackName || contact.phone || contact.email; if (contact.name) clients.push(contact) }
      contact = null; continue
    }
    if (!contact) continue
    const match = line.match(/^((?:[^:"]|"[^"]*")+):(.*)$/)
    if (!match) continue
    const property = match[1].split(';')[0].split('.').pop()?.toUpperCase()
    const value = vcardValue(match[1], match[2])
    if (property === 'FN') contact.name = value
    if (property === 'N') {
      const parts = match[2].split(/(?<!\\);/).map(p => vcardValue(match[1], p))
      fallbackName = [parts[3], parts[1], parts[2], parts[0], parts[4]].filter(Boolean).join(' ')
    }
    if (property === 'TEL') {
      const phone = value.replace(/^tel:/i, '')
      if (!contact.phone) contact.phone = phone
      else if (contact.phone !== phone) contact.notes += `${contact.notes ? '\n' : ''}Additional phone: ${phone}`
    }
    if (property === 'EMAIL') {
      if (!contact.email) contact.email = value.replace(/^mailto:/i, '')
      else if (contact.email !== value) contact.notes += `${contact.notes ? '\n' : ''}Additional email: ${value}`
    }
    if (property === 'NOTE' && value) contact.notes += `${contact.notes ? '\n' : ''}${value}`
  }
  if (contact) throw new Error('Incomplete vCard: END:VCARD is missing.')
  if (!clients.length) throw new Error('No contacts found in this vCard file.')
  return clients
}
