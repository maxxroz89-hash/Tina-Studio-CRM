import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { clientKeys, IMPORT_BATCH_SIZE, uniqueClients, type ImportedClient } from '@/lib/client-import'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: business } = await supabase.from('businesses').select('id').eq('owner_id', user.id).order('created_at').limit(1).maybeSingle()
  if (!business) return NextResponse.json({ error: 'Business not found' }, { status: 404 })

  if (Number(req.headers.get('content-length')) > 1024 * 1024) return NextResponse.json({ error: 'Import request is too large.' }, { status: 413 })
  let body: unknown
  try {
    const bytes = await req.arrayBuffer()
    if (bytes.byteLength > 1024 * 1024) return NextResponse.json({ error: 'Import request is too large.' }, { status: 413 })
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const raw = body && typeof body === 'object' && 'clients' in body ? body.clients : null
  if (!Array.isArray(raw) || raw.length > IMPORT_BATCH_SIZE || raw.some(row => !row || typeof row !== 'object' || ['name', 'phone', 'email', 'notes'].some(key => row[key] != null && typeof row[key] !== 'string'))) {
    return NextResponse.json({ error: `Send up to ${IMPORT_BATCH_SIZE} contacts with text fields per request.` }, { status: 400 })
  }
  const clean = (s: string | undefined, max: number) => (s ?? '').trim().slice(0, max)
  const rows: ImportedClient[] = raw.map(row => ({ name: clean(row.name, 100), phone: clean(row.phone, 50), email: clean(row.email, 254), notes: clean(row.notes, 1000) }))
  const unique = uniqueClients(rows)
  if (!unique.clients.length) return NextResponse.json({ imported: 0, skipped: raw.length, errors: [] })

  // Match canonical keys without modifying existing client records or phone formatting.
  const seen = new Set<string>()
  if (unique.clients.some(row => clientKeys(row).length)) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from('clients').select('phone,email').eq('business_id', business.id).order('id').range(offset, offset + 999)
      if (error) return NextResponse.json({ error: 'Could not check existing clients. Nothing was imported in this batch.' }, { status: 500 })
      data.forEach(row => clientKeys({ phone: row.phone ?? '', email: row.email ?? '' }).forEach(key => seen.add(key)))
      if (data.length < 1000) break
    }
  }
  const pending = unique.clients.filter(row => !clientKeys(row).some(key => seen.has(key)))
  if (!pending.length) return NextResponse.json({ imported: 0, skipped: raw.length, errors: [] })
  // One statement makes each batch atomic. RLS and the unique phone constraint still apply.
  const { data, error } = await supabase.from('clients').upsert(pending.map(row => ({ business_id: business.id, name: row.name, phone: row.phone || null, email: row.email || null, notes: row.notes || null, tags: [] as string[] })), { onConflict: 'business_id,phone', ignoreDuplicates: true }).select('id')
  if (error) {
    console.error('[clients/import] insert failed:', error.code)
    return NextResponse.json({ error: 'Could not save this batch. Previously completed batches are kept.' }, { status: 500 })
  }
  const imported = data?.length ?? 0
  return NextResponse.json({ imported, skipped: raw.length - imported, errors: [] })
}
