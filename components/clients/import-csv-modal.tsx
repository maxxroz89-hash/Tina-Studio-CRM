'use client'

import { useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { X, Upload, ContactRound, CheckCircle, AlertCircle } from 'lucide-react'
import { IMPORT_BATCH_SIZE, MAX_IMPORT_CLIENTS, matrixToClients, parseClientsCsv, parseVcard, uniqueClients, type ImportedClient } from '@/lib/client-import'

interface Props { open: boolean; onClose: () => void; onImported: (count: number) => void }
interface DeviceContact { name?: string[]; tel?: string[]; email?: string[] }
interface ContactPicker { select: (fields: string[], options: { multiple: boolean }) => Promise<DeviceContact[]> }
type Item = ImportedClient & { selected: boolean }

export function ImportCsvModal({ open, onClose, onImported }: Props) {
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sources, setSources] = useState<string[]>([])
  const [skipped, setSkipped] = useState(0)
  const [result, setResult] = useState<{ imported: number; skipped: number; failed: boolean } | null>(null)
  const [progress, setProgress] = useState(0)
  const [page, setPage] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const lock = useRef(false)
  const selected = items.filter(item => item.selected)
  const preview = items.slice(page * 50, (page + 1) * 50)

  function close() {
    if (lock.current) return
    setItems([]); setSources([]); setError(''); setSkipped(0); setResult(null); setProgress(0); setPage(0)
    onClose()
  }

  function addContacts(rows: ImportedClient[], names: string[]) {
    if (!rows.length) return
    if (items.length + rows.length > MAX_IMPORT_CLIENTS) throw new Error(`Import up to ${MAX_IMPORT_CLIENTS} contacts at a time.`)
    const combined = uniqueClients([...items, ...rows])
    if (!combined.clients.length) throw new Error('No named contacts found. Check the name column or contact names before importing.')
    const previous = new Map(items.map(item => [item, item.selected]))
    setItems(combined.clients.map(item => ({ ...item, selected: previous.get(item as Item) ?? true })))
    setSkipped(count => count + combined.skipped)
    setSources(current => [...current, ...names]); setPage(0)
  }

  async function readFiles(files: File[]) {
    if (!files.length || lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      if (files.length > 20 || files.reduce((sum, f) => sum + f.size, 0) > 10 * 1024 * 1024) throw new Error('Choose up to 20 files, with a combined size of 10 MB or less.')
      const rows: ImportedClient[] = [], names: string[] = [], errors: string[] = []
      for (const file of files) {
        try {
          if (file.size > 5 * 1024 * 1024) throw new Error('File exceeds 5 MB.')
          const extension = file.name.split('.').pop()?.toLowerCase()
          let parsed: ImportedClient[] = []
          if (extension === 'vcf' || extension === 'vcard') parsed = parseVcard(await file.text())
          else if (extension === 'csv' || extension === 'tsv') parsed = parseClientsCsv(await file.text())
          else if (extension === 'xlsx' || extension === 'xls') {
            const XLSX = await import('xlsx')
            const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
            for (const name of workbook.SheetNames) {
              const matrix = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[name], { header: 1, raw: false, defval: '' })
              if (matrix.length > 1) parsed.push(...matrixToClients(matrix))
            }
            if (!parsed.length) throw new Error('No contacts found in this workbook.')
          } else throw new Error('Supported formats: CSV, TSV, XLSX, XLS, VCF.')
          if (rows.length + parsed.length + items.length > MAX_IMPORT_CLIENTS) throw new Error(`Import up to ${MAX_IMPORT_CLIENTS} contacts at a time.`)
          rows.push(...parsed); names.push(file.name)
        } catch (err) { errors.push(`${file.name}: ${err instanceof Error ? err.message : 'Could not read file.'}`) }
      }
      if (rows.length) addContacts(rows, names)
      setError(errors.join('\n'))
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not read files.') }
    finally { lock.current = false; setBusy(false) }
  }

  async function pickContacts() {
    const picker = (navigator as Navigator & { contacts?: ContactPicker }).contacts
    if (!picker?.select) {
      setError('This browser cannot open the phone book directly. Export contacts as a vCard (.vcf), then choose that file here. iPhone: Contacts → Lists → hold a list → Export. Android: Contacts → Organize / Manage → Export to file.')
      return
    }
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const contacts = await picker.select(['name', 'tel', 'email'], { multiple: true })
      addContacts(contacts.map(c => ({ name: c.name?.join(' ') || c.tel?.[0] || c.email?.[0] || '', phone: c.tel?.[0] ?? '', email: c.email?.[0] ?? '', notes: [...(c.tel?.slice(1) ?? []).map(t => `Additional phone: ${t}`), ...(c.email?.slice(1) ?? []).map(e => `Additional email: ${e}`)].join('\n') })), contacts.length ? ['Phone book'] : [])
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError('Contacts access was not granted. Select contacts again or import a .vcf file.')
    } finally { lock.current = false; setBusy(false) }
  }

  async function importSelected() {
    if (!selected.length || lock.current) return
    lock.current = true; setBusy(true); setError(''); setProgress(0)
    let imported = 0, ignored = skipped, completed = 0
    try {
      for (let offset = 0; offset < selected.length; offset += IMPORT_BATCH_SIZE) {
        const batch = selected.slice(offset, offset + IMPORT_BATCH_SIZE)
        const response = await fetch('/api/clients/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clients: batch.map(({ name, phone, email, notes }) => ({ name, phone, email, notes })) }) })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? 'Import failed.')
        imported += data.imported; ignored += data.skipped; completed += batch.length; setProgress(completed)
      }
      setResult({ imported, skipped: ignored, failed: false })
    } catch (err) {
      setError(`${err instanceof Error ? err.message : 'Connection interrupted.'} ${completed} of ${selected.length} contacts processed. Check your client list before importing again.`)
      setResult({ imported, skipped: ignored, failed: true })
    } finally { lock.current = false; setBusy(false); onImported(imported) }
  }

  return (
    <Dialog.Root open={open} onOpenChange={value => { if (!value) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-white rounded-xl shadow-xl w-[calc(100%-2rem)] max-w-2xl max-h-[90dvh] overflow-y-auto p-5 focus:outline-none" onEscapeKeyDown={e => { if (busy) e.preventDefault() }} onPointerDownOutside={e => { if (busy) e.preventDefault() }}>
          <div className="flex justify-between gap-3 mb-2"><Dialog.Title className="text-lg font-semibold">Import clients</Dialog.Title><button type="button" aria-label="Close import" disabled={busy} onClick={close}><X className="w-5 h-5" /></button></div>
          <Dialog.Description className="text-sm text-gray-600 mb-4">Choose contacts from your phone book or upload several contact files. Review and select clients before saving.</Dialog.Description>
          {!result && <>
            <div className="flex flex-wrap gap-2 mb-3"><Button type="button" variant="outline" disabled={busy} onClick={pickContacts}><ContactRound className="w-4 h-4 mr-2" />Phone book</Button><Button type="button" variant="outline" disabled={busy} onClick={() => input.current?.click()}><Upload className="w-4 h-4 mr-2" />Choose files</Button></div>
            <input ref={input} type="file" multiple accept=".csv,.tsv,.xlsx,.xls,.vcf,.vcard" className="hidden" aria-label="Contact files" disabled={busy} onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void readFiles(files) }} />
            <button type="button" disabled={busy} onClick={() => input.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void readFiles(Array.from(e.dataTransfer.files)) }} className="w-full border-2 border-dashed rounded-xl p-5 text-sm text-gray-600 mb-3 disabled:opacity-50">Drop one or more CSV, Excel or vCard files here<br /><span className="text-xs text-gray-500">Up to 20 files · 5 MB per file · 10 MB combined · 5,000 contacts</span></button>
            <p className="text-xs text-gray-500 mb-3">iPhone or unsupported browser? Export your phone book as .vcf and choose the file. Tables should use name, phone, email and notes columns. First / last name and Google Contacts exports are also supported.</p>
            {sources.length > 0 && <p className="text-xs text-gray-500 mb-3 break-words">Sources: {sources.join(', ')}</p>}
            {items.length > 0 && <>
              <label className="flex gap-2 text-sm mb-3"><input type="checkbox" disabled={busy} checked={selected.length === items.length} onChange={e => { const checked = e.target.checked; setItems(current => current.map(item => ({ ...item, selected: checked }))) }} />Select all ({selected.length} / {items.length})</label>
              <div className="overflow-auto max-h-72 border rounded-lg"><table className="w-full text-sm"><thead className="bg-gray-50"><tr><th className="p-2"><span className="sr-only">Select</span></th><th className="p-2 text-left">Name</th><th className="p-2 text-left">Phone</th><th className="p-2 text-left">Email</th></tr></thead><tbody>{preview.map((item, index) => <tr key={page * 50 + index} className="border-t"><td className="p-2"><input type="checkbox" aria-label={`Select ${item.name}`} checked={item.selected} disabled={busy} onChange={e => { const checked = e.target.checked; setItems(current => current.map((row, i) => i === page * 50 + index ? { ...row, selected: checked } : row)) }} /></td><td className="p-2 max-w-48 break-words">{item.name}</td><td className="p-2 whitespace-nowrap">{item.phone || '—'}</td><td className="p-2 break-all">{item.email || '—'}</td></tr>)}</tbody></table></div>
              {items.length > 50 && <div className="flex justify-between items-center text-xs my-2"><button disabled={busy || !page} onClick={() => setPage(p => p - 1)}>Previous</button><span>Page {page + 1} / {Math.ceil(items.length / 50)}</span><button disabled={busy || (page + 1) * 50 >= items.length} onClick={() => setPage(p => p + 1)}>Next</button></div>}
              <p className="text-xs text-gray-500 my-3">{skipped > 0 ? `${skipped} duplicate or unnamed contacts removed. ` : ''}Existing clients are kept. Duplicates are matched by phone or email. Contacts without either may be imported again.</p>
              {busy && <p role="status" className="text-sm my-2">Processing… {progress} / {selected.length}</p>}
              <Button type="button" disabled={busy || !selected.length} onClick={importSelected} className="w-full">{busy ? 'Processing…' : `Import ${selected.length} clients`}</Button>
            </>}
          </>}
          {result && <div className="py-4 text-center" role="status"><CheckCircle className="w-10 h-10 text-green-600 mx-auto mb-3" /><h3 className="font-semibold">{result.failed ? 'Import stopped' : 'Import complete'}</h3><p className="my-2">{result.imported} clients added · {result.skipped} skipped</p><Button onClick={close}>Done</Button></div>}
          {error && <div role="alert" className="mt-3 flex gap-2 text-sm text-red-700 bg-red-50 p-3 rounded-lg whitespace-pre-line"><AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />{error}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
