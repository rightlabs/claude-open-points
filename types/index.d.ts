export type PointStatus = 'check' | 'call' | 'active' | 'open' | 'later' | 'done' | 'dropped'

export type Point = {
  id: string | null
  title: string
  status: PointStatus
  section: string
  isUrgent: boolean
}

export type PointsDoc = {
  path: string
  mtimeMs: number
  points: Point[]
}

declare module 'claude-code' {
  interface PluginState {
    'open-points': {
      doc: PointsDoc | null
      error: string | null
      expanded: string[]
    }
  }
}
