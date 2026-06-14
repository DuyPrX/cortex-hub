/**
 * mem9 proxy routes — REST API for hub-mcp memory tools
 *
 * Translates REST calls → in-process Mem9 operations.
 * Endpoints:
 *   POST /store   → Mem9.add()
 *   POST /search  → Mem9.search()
 *   POST /embed   → Embedder.embed() (for knowledge search)
 *   GET  /health  → Mem9.isReady()
 */

import { Hono } from 'hono'
import { Mem9, Embedder } from '@cortex/shared-mem9'
import type { Mem9Config } from '@cortex/shared-mem9'
import { db } from '../db/client.js'
import { createEmbedder } from '../lib/embedder-factory.js'

export const mem9ProxyRouter = new Hono()

/** Lazily initialize Mem9 instance (singleton) */
let mem9Instance: Mem9 | null = null
let embedderInstance: Embedder | null = null

/**
 * Resolve the LLM model for mem9 (fact extraction, dedup).
 * Priority: MEM9_LLM_MODEL env → chat routing chain from DB → fallback
 */
function resolveLlmModel(): string {
  // 1. Dashboard chat routing chain (what user selected in Providers UI)
  try {
    const row = db.prepare(
      "SELECT chain FROM model_routing WHERE purpose = 'chat'"
    ).get() as { chain: string } | undefined
    if (row?.chain) {
      const chain = JSON.parse(row.chain) as { model?: string }[]
      if (chain[0]?.model) return chain[0].model
    }
  } catch {
    // DB might not be ready yet
  }

  // 2. Explicit env var
  const envModel = process.env['MEM9_LLM_MODEL']
  if (envModel) return envModel

  // 3. Fallback
  return ''
}

/**
 * Build a config fingerprint to detect when settings change
 * and singleton needs to be recreated.
 */
function configFingerprint(): string {
  return resolveLlmModel()
}

let lastFingerprint = ''

function getMem9Config(): Mem9Config {
  const gatewayUrl = process.env['LLM_GATEWAY_URL'] ?? `http://localhost:${process.env['PORT'] || 4000}/api/llm`

  return {
    llm: {
      baseUrl: `http://localhost:${process.env['PORT'] || 4000}/api/llm/v1`,
      model: resolveLlmModel(),
    },
    embedder: {
      provider: 'gemini' as const, // Dummy to bypass local check
      apiKey: '',
      model: 'gemini-embedding-001',
      gatewayUrl,
    },
    vectorStore: {
      url: process.env['QDRANT_URL'] || 'http://qdrant:6333',
      collection: 'cortex_memories',
    },
  }
}

export function getMem9(): Mem9 {
  const fp = configFingerprint()
  if (!mem9Instance || fp !== lastFingerprint) {
    lastFingerprint = fp
    mem9Instance = new Mem9(getMem9Config())
    embedderInstance = null // also invalidate embedder
  }
  return mem9Instance
}

function getEmbedder(): Embedder {
  const fp = configFingerprint()
  if (!embedderInstance || fp !== lastFingerprint) {
    lastFingerprint = fp
    embedderInstance = createEmbedder()
  }
  return embedderInstance
}

function normalizeProjectId(projectId: string | null | undefined): string | null {
  if (!projectId) return null
  try {
    const project = db.prepare(
      `SELECT id FROM projects
       WHERE id = ?
          OR slug = ? COLLATE NOCASE
          OR name = ? COLLATE NOCASE`
    ).get(projectId, projectId, projectId) as { id: string } | undefined

    if (project?.id) {
      return project.id
    }
  } catch (error) {
    console.warn(`normalizeProjectId failed: ${error}`)
  }
  return projectId
}

function normalizeMemoryUserId(userId: string): string {
  if (!userId) return userId
  if (userId.startsWith('project-')) {
    const branchIndex = userId.indexOf(':branch-')
    if (branchIndex !== -1) {
      const projectIdRaw = userId.slice('project-'.length, branchIndex)
      const branchPart = userId.slice(branchIndex)
      const normalizedId = normalizeProjectId(projectIdRaw)
      return `project-${normalizedId}${branchPart}`
    } else {
      const projectIdRaw = userId.slice('project-'.length)
      const normalizedId = normalizeProjectId(projectIdRaw)
      return `project-${normalizedId}`
    }
  }
  return userId
}

/**
 * POST /store — Store a memory
 * Body: { messages, userId, agentId?, metadata? }
 */
mem9ProxyRouter.post('/store', async (c) => {
  try {
    const body = await c.req.json()
    const { messages, userId, agentId, metadata } = body

    if (!messages || !userId) {
      return c.json({ error: 'messages and userId are required' }, 400)
    }

    const normalizedUserId = normalizeMemoryUserId(userId)
    const normalizedMetadata = { ...(metadata ?? {}) }
    if (normalizedMetadata.project_id) {
      normalizedMetadata.project_id = normalizeProjectId(normalizedMetadata.project_id)
    }

    const mem9 = getMem9()
    const result = await mem9.add({
      messages,
      userId: normalizedUserId,
      agentId: agentId ?? 'default',
      metadata: normalizedMetadata,
    })

    c.header('X-Cortex-Compute-Tokens', String(result.tokensUsed || 0))
    c.header('X-Cortex-Compute-Model', resolveLlmModel())

    return c.json({
      success: true,
      events: result.events,
      tokensUsed: result.tokensUsed,
    })
  } catch (error) {
    console.error('[mem9-proxy] store error:', error)
    return c.json({ error: String(error) }, 500)
  }
})

/**
 * POST /search — Search memories by semantic similarity
 * Body: { query, userId, agentId?, limit? }
 */
mem9ProxyRouter.post('/search', async (c) => {
  try {
    const body = await c.req.json()
    const { query, userId, agentId, limit } = body

    if (!query || !userId) {
      return c.json({ error: 'query and userId are required' }, 400)
    }

    const normalizedUserId = normalizeMemoryUserId(userId)
    const mem9 = getMem9()
    const result = await mem9.search({
      query,
      userId: normalizedUserId,
      agentId,
      limit,
    })

    c.header('X-Cortex-Compute-Tokens', String(result.tokensUsed || 0))
    c.header('X-Cortex-Compute-Model', resolveLlmModel())

    return c.json({
      memories: result.memories,
      tokensUsed: result.tokensUsed,
    })
  } catch (error) {
    console.error('[mem9-proxy] search error:', error)
    return c.json({ error: String(error) }, 500)
  }
})


/**
 * DELETE /:id — Delete a single memory by ID
 */
mem9ProxyRouter.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const mem9 = getMem9()
    await mem9.delete(id)
    return c.json({ success: true, id })
  } catch (error) {
    console.error('[mem9-proxy] delete error:', error)
    return c.json({ error: String(error) }, 500)
  }
})

/**
 * POST /embed — Embed text to vector (for knowledge search)
 * Body: { text }
 */
mem9ProxyRouter.post('/embed', async (c) => {
  try {
    const body = await c.req.json()
    const { text } = body

    if (!text) {
      return c.json({ error: 'text is required' }, 400)
    }

    const embedder = getEmbedder()
    const vector = await embedder.embed(text)

    return c.json({ vector, dimensions: vector.length })
  } catch (error) {
    console.error('[mem9-proxy] embed error:', error)
    return c.json({ error: String(error) }, 500)
  }
})

/**
 * GET /health — Check if mem9 dependencies are reachable
 */
mem9ProxyRouter.get('/health', async (c) => {
  try {
    const mem9 = getMem9()
    const status = await mem9.isReady()

    return c.json({
      status: status.llm && status.vectorStore ? 'healthy' : 'degraded',
      llm: status.llm ? 'ok' : 'error',
      vectorStore: status.vectorStore ? 'ok' : 'error',
    })
  } catch (error) {
    return c.json({
      status: 'error',
      error: String(error),
    }, 500)
  }
})
