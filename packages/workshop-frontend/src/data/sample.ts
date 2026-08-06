/** A specific resource within a connection (channel, doc URL, repo, etc.) */
export interface ConnectionResource {
  id: string
  label: string
  /** e.g. "#general", "https://docs.google.com/...", "org/repo" */
  value: string
  /** Resource type hint */
  type: 'channel' | 'url' | 'repo' | 'project' | 'board' | 'page' | 'file' | 'server' | 'database'
  active: boolean
}

/** Describes what kind of resource input a connection accepts */
export interface ResourceConfig {
  /** What the user adds: channels, URLs, repos, etc. */
  resourceType: 'channel' | 'url' | 'repo' | 'project' | 'board' | 'page' | 'file' | 'server' | 'database'
  /** Placeholder text for the input */
  placeholder: string
  /** Label shown above the input */
  inputLabel: string
  /** Whether the connection offers a browse/search picker (vs. paste-only) */
  browsable: boolean
}

export interface Connection {
  id: string
  name: string
  description: string
  /** SVG path or icon identifier */
  logo: string
  /** Brand color for the logo background */
  color: string
  /** Light tint for background */
  bgColor: string
  connected: boolean
  lastUsed?: string
  /** Configured resources for this connection */
  resources?: ConnectionResource[]
  /** Describes what resources can be added */
  resourceConfig?: ResourceConfig
}

export interface InlineDemo {
  id: string
  label: string
  prompt: string
}

export interface App {
  id: string
  title: string
  description: string
  gradient: string
  updatedAt: string
  status: 'live' | 'draft' | 'building'
  /** Which connections this app uses */
  connectionIds: string[]
}

export interface Template {
  id: string
  title: string
  description: string
  category: 'apps' | 'landing-pages' | 'components' | 'dashboards'
  gradient: string
  author: {
    name: string
    avatar: string
  }
  uses: number
  likes: number
  price: 'Free' | string
}

// ---------------------
// Inline demo prompts shown under the chat input
// ---------------------
export const inlineDemos: InlineDemo[] = [
  {
    id: 'd1',
    label: 'チャンネルをまとめたSlackボット',
    prompt: 'Build a Slack bot that summarizes unread channels daily',
  },
  {
    id: 'd2',
    label: 'Jira スプリント ダッシュボード',
    prompt: 'Create a sprint dashboard that pulls from Jira and shows burndown charts',
  },
  {
    id: 'd3',
    label: 'Discordモデレーションツール',
    prompt: 'Build a Discord moderation tool with auto-flagging and audit logs',
  },
  {
    id: 'd4',
    label: 'Google スプレッドシートの経費トラッカー',
    prompt: 'Create an expense tracker that syncs to Google Sheets',
  },
  {
    id: 'd5',
    label: 'GitHub PR レビュー ダッシュボード',
    prompt: 'Build a PR review dashboard that shows open reviews across repos',
  },
]

// ---------------------
// Connections (external data sources)
// ---------------------
export const connections: Connection[] = [
  {
    id: 'slack',
    name: 'Slack',
    description: 'チャンネル、メッセージ、スレッド',
    logo: 'slack',
    color: '#4A154B',
    bgColor: '#f4ecf5',
    connected: true,
    lastUsed: '2 hours ago',
    resourceConfig: {
      resourceType: 'channel',
      placeholder: '#channel-name',
      inputLabel: 'Add a channel',
      browsable: true,
    },
    resources: [
      { id: 'r-s1', label: '#general', value: '#general', type: 'channel', active: true },
      { id: 'r-s2', label: '#engineering', value: '#engineering', type: 'channel', active: true },
      { id: 'r-s3', label: '#product', value: '#product', type: 'channel', active: false },
    ],
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'サーバー、チャネル、メッセージ',
    logo: 'discord',
    color: '#5865F2',
    bgColor: '#eef0ff',
    connected: true,
    lastUsed: '5 hours ago',
    resourceConfig: {
      resourceType: 'server',
      placeholder: 'サーバー名または招待リンク',
      inputLabel: 'Add a server',
      browsable: true,
    },
    resources: [
      { id: 'r-d1', label: 'Acme 開発サーバー', value: 'acme-dev', type: 'server', active: true },
    ],
  },
  {
    id: 'jira',
    name: 'Jira',
    description: '課題、スプリント、ボード',
    logo: 'jira',
    color: '#0052CC',
    bgColor: '#e6efff',
    connected: true,
    lastUsed: '1 day ago',
    resourceConfig: {
      resourceType: 'board',
      placeholder: 'ボード名またはプロジェクト キー (例: ENG)',
      inputLabel: 'Add a board or project',
      browsable: true,
    },
    resources: [
      { id: 'r-j1', label: 'ENGボード', value: 'ENG', type: 'board', active: true },
      { id: 'r-j2', label: 'デザインボード', value: 'DESIGN', type: 'board', active: true },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    description: 'ドライブ、スプレッドシート、ドキュメント、カレンダー',
    logo: 'google',
    color: '#4285F4',
    bgColor: '#e8f0fe',
    connected: true,
    lastUsed: '3 hours ago',
    resourceConfig: {
      resourceType: 'url',
      placeholder: 'Google ドキュメント、スプレッドシート、またはドライブの URL を貼り付けます',
      inputLabel: 'Add a document',
      browsable: false,
    },
    resources: [
      { id: 'r-g1', label: '第 1 四半期の計画ドキュメント', value: 'https://docs.google.com/document/d/1a2b3c', type: 'url', active: true },
      { id: 'r-g2', label: '経費追跡ツール', value: 'https://docs.google.com/spreadsheets/d/4d5e6f', type: 'url', active: true },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'リポジトリ、問題、プル リクエスト',
    logo: 'github',
    color: '#24292e',
    bgColor: '#f0f0f0',
    connected: false,
    resourceConfig: {
      resourceType: 'repo',
      placeholder: 'org/repo-name',
      inputLabel: 'Add a repository',
      browsable: true,
    },
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'ページ、データベース、Wiki',
    logo: 'notion',
    color: '#000000',
    bgColor: '#f5f5f5',
    connected: false,
    resourceConfig: {
      resourceType: 'page',
      placeholder: 'Notion ページの URL を貼り付けます',
      inputLabel: 'Add a page or database',
      browsable: false,
    },
  },
  {
    id: 'linear',
    name: 'Linear',
    description: '課題、プロジェクト、サイクル',
    logo: 'linear',
    color: '#5E6AD2',
    bgColor: '#eeeffa',
    connected: false,
    resourceConfig: {
      resourceType: 'project',
      placeholder: 'プロジェクト名または識別子',
      inputLabel: 'Add a project',
      browsable: true,
    },
  },
  {
    id: 'figma',
    name: 'Figma',
    description: '設計ファイルとコンポーネント',
    logo: 'figma',
    color: '#F24E1E',
    bgColor: '#fef0ec',
    connected: false,
    resourceConfig: {
      resourceType: 'file',
      placeholder: 'Figma ファイルの URL を貼り付けます',
      inputLabel: 'Add a design file',
      browsable: false,
    },
  },
]

export const recentConnections = connections.filter((c) => c.connected)

// ---------------------
// Recent apps
// ---------------------
export const recentApps: App[] = [
  {
    id: 'app-1',
    title: 'Slack チャンネルサマライザー',
    description: 'Workers AI を使用して、未読の Slack チャネルを 1 日のダイジェストに要約します',
    gradient: 'from-[#4A154B] to-[#7C3085]',
    updatedAt: '2 hours ago',
    status: 'live',
    connectionIds: ['slack'],
  },
  {
    id: 'app-2',
    title: 'スプリントバーンダウントラッカー',
    description: 'Jira スプリント データを取得し、バーンダウン チャートをリアルタイムでレンダリングします。',
    gradient: 'from-[#0052CC] to-[#2684FF]',
    updatedAt: '5 hours ago',
    status: 'live',
    connectionIds: ['jira'],
  },
  {
    id: 'app-3',
    title: 'Discord Mod ダッシュボード',
    description: 'メッセージに自動フラグを付け、Discord サーバーの監査ログを表示します',
    gradient: 'from-[#5865F2] to-[#7983F5]',
    updatedAt: '1 day ago',
    status: 'draft',
    connectionIds: ['discord'],
  },
  {
    id: 'app-4',
    title: '経費追跡ツール',
    description: '経費を追跡し、合計を Google スプレッドシートに自動的に同期します',
    gradient: 'from-[#34A853] to-[#4285F4]',
    updatedAt: '2 days ago',
    status: 'live',
    connectionIds: ['google'],
  },
  {
    id: 'app-5',
    title: 'PRレビューキュー',
    description: 'すべてのリポジトリにわたるオープンなプルリクエストをレビューステータスとともに表示します',
    gradient: 'from-[#24292e] to-[#555]',
    updatedAt: '3 days ago',
    status: 'building',
    connectionIds: ['github'],
  },
  {
    id: 'app-6',
    title: 'チームスタンドアップボット',
    description: 'Slack から非同期スタンドアップを収集し、概要を Notion に投稿します',
    gradient: 'from-[#E01E5A] to-[#ECB22E]',
    updatedAt: '4 days ago',
    status: 'live',
    connectionIds: ['slack', 'notion'],
  },
]

// ---------------------
// Templates
// ---------------------
export const templates: Template[] = [
  {
    id: '1',
    title: 'ワーカー AI プレイグラウンド',
    description: 'ストリーミング応答を備えたインタラクティブな AI モデル プレイグラウンド',
    category: 'apps',
    gradient: 'from-orange-600 via-red-600 to-pink-600',
    author: { name: 'cloudflare', avatar: 'CF' },
    uses: 4900,
    likes: 591,
    price: 'Free',
  },
  {
    id: '2',
    title: 'SaaS ランディング ページ',
    description: '価格と機能を備えた最新の SaaS ランディング ページ',
    category: 'landing-pages',
    gradient: 'from-blue-600 via-indigo-600 to-violet-600',
    author: { name: 'designco', avatar: 'DC' },
    uses: 11400,
    likes: 1700,
    price: 'Free',
  },
  {
    id: '3',
    title: 'D1 データベース エクスプローラー',
    description: 'Cloudflare D1 のビジュアル データベース エクスプローラー',
    category: 'apps',
    gradient: 'from-emerald-600 via-teal-600 to-cyan-600',
    author: { name: 'devtools', avatar: 'DT' },
    uses: 2900,
    likes: 737,
    price: 'Free',
  },
  {
    id: '4',
    title: 'KV ストアマネージャー',
    description: 'クリーンな UI で Workers KV 名前空間を管理する',
    category: 'dashboards',
    gradient: 'from-violet-600 via-purple-600 to-fuchsia-600',
    author: { name: 'cloudflare', avatar: 'CF' },
    uses: 919,
    likes: 235,
    price: 'Free',
  },
  {
    id: '5',
    title: 'AIゲートウェイスターター',
    description: 'Cloudflareを介してAI API呼び出しをルーティングおよび管理する',
    category: 'apps',
    gradient: 'from-gray-800 via-gray-700 to-gray-600',
    author: { name: 'aitools', avatar: 'AI' },
    uses: 1200,
    likes: 235,
    price: 'Free',
  },
  {
    id: '6',
    title: 'R2 ファイルブラウザ',
    description: 'Cloudflare R2に保存されているファイルのアップロードと参照',
    category: 'components',
    gradient: 'from-amber-600 via-orange-600 to-red-600',
    author: { name: 'storage', avatar: 'ST' },
    uses: 1600,
    likes: 502,
    price: 'Free',
  },
]

export const templateCategories = [
  { id: 'apps', label: 'アプリとゲーム', icon: 'blocks' },
  { id: 'landing-pages', label: 'ランディングページ', icon: 'layout' },
  { id: 'components', label: 'コンポーネント', icon: 'grid' },
  { id: 'dashboards', label: 'ダッシュボード', icon: 'bar-chart' },
] as const

export function formatNumber(num: number): string {
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return num.toString()
}
