import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClientsCsv, parseVcard, uniqueClients } from '../lib/client-import.ts'

test('CSV handles BOM, quoted separators, multiline notes and Cyrillic names', () => {
  const rows = parseClientsCsv('\uFEFFname,phone,email,notes\r\n"Анна, А",+972501234567,a@example.com,"line 1\nline 2"')
  assert.deepEqual(rows, [{ name: 'Анна, А', phone: '+972501234567', email: 'a@example.com', notes: 'line 1\nline 2' }])
})

test('semicolon, TSV and Google Contacts headings preserve first and last names', () => {
  assert.equal(parseClientsCsv('First Name;Last Name;Phone 1 - Value\nAnna;Smith;+123')[0].name, 'Anna Smith')
  assert.equal(parseClientsCsv('имя\tтелефон\nАнна\t0501234567')[0].phone, '0501234567')
})

test('CSV rejects malformed files and missing names instead of silently losing contacts', () => {
  assert.throws(() => parseClientsCsv('phone,email\n123,a@example.com'), /Name column/)
  assert.throws(() => parseClientsCsv('name,notes\nAnna,"unfinished'), /Unclosed quote/)
})

test('multi-contact vCard supports folded names, grouped fields and additional numbers', () => {
  const rows = parseVcard('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Anna\r\n  Smith\r\nitem1.TEL;TYPE=CELL:+972 50 123 4567\r\nTEL:+123\r\nEMAIL:a@example.com\r\nNOTE:Hello\\nWorld\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:4.0\r\nN:Иванова;Анна;;;\r\nTEL;VALUE=uri:tel:+456\r\nEND:VCARD')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'Anna Smith')
  assert.equal(rows[0].notes, 'Additional phone: +123\nHello\nWorld')
  assert.equal(rows[1].name, 'Анна Иванова')
  assert.equal(rows[1].phone, '+456')
})

test('vCard decodes quoted printable UTF-8 and soft line breaks', () => {
  const [row] = parseVcard('BEGIN:VCARD\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D0=90=D0=BD=\n=D0=BD=D0=B0\nTEL:123\nEND:VCARD')
  assert.equal(row.name, 'Анна')
})

test('vCard keeps escaped separators and rejects truncated contact files', () => {
  assert.equal(parseVcard('BEGIN:VCARD\nFN:Anna\\; Smith\nEND:VCARD')[0].name, 'Anna; Smith')
  assert.throws(() => parseVcard('BEGIN:VCARD\nFN:Anna'), /END:VCARD/)
})

test('deduplication spans files and normalizes international phones and email case', () => {
  const row = { name: 'Anna', phone: '+972 (50) 123-4567', email: '', notes: '' }
  const result = uniqueClients([row, { ...row, phone: '00972501234567' }, { ...row, phone: '', email: 'Anna@Example.com' }, { ...row, phone: '', email: 'anna@example.com' }, { ...row, name: '', phone: '123' }])
  assert.equal(result.clients.length, 2)
  assert.equal(result.skipped, 3)
})
