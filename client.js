window.__ModuleLoader__.load({
  id: 'dsh-neo4j-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-neo4j-memory'
    const SECRET_FIELDS = ['apiKey', 'embeddingApiKey', 'alignmentApiKey', 'neo4jPassword']
    const MODES = ['auto', 'managed', 'external']
    const GRAPH_URL = '/dsh-neo4j-memory/graph/'
    const MODEL_FIELDS = [
      'extractionBaseUrl', 'extractionModel',
      'embeddingBaseUrl', 'embeddingModel',
      'alignmentBaseUrl', 'alignmentModel',
    ]
    const BASE_URL_FIELDS = ['extractionBaseUrl', 'embeddingBaseUrl', 'alignmentBaseUrl']
    const MODEL_PLACEHOLDERS = {
      extractionBaseUrl: 'https://api.deepseek.com',
      extractionModel: 'deepseek-flash',
      embeddingBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      embeddingModel: 'qwen3.7-text-embedding',
      alignmentBaseUrl: 'https://api.typesafe.ai/v1/systemone',
      alignmentModel: 'jev',
    }
    const DEFAULT_ALIGNMENT_THRESHOLD = 0.95

    const zh = {
      nav: 'Neo4j 记忆',
      title: 'Neo4j 记忆',
      intro: '查看只读的记忆图谱，并配置本地或外部 Neo4j 与模型 Key。不填任何密码时，插件使用本地 Neo4j（首次调用时自动下载）。',
      mode: 'Neo4j 模式',
      modeAuto: '自动（未配置外部连接时使用本地）',
      modeManaged: '仅使用本地 Neo4j',
      modeExternal: '仅使用外部 Neo4j',
      conceptAlignment: '写入前做概念对齐',
      conceptAlignmentHint: '开启时调用 TypeSafe 判断概念是否同义；关闭后跳过这次调用，只按名称或别名复用已有概念，此时不需要概念对齐 Key。',
      apiKey: '提取模型 API Key',
      embeddingApiKey: '向量模型 API Key',
      alignmentApiKey: '概念对齐 API Key',
      neo4jPassword: '外部 Neo4j 密码',
      dataDir: '本地数据目录',
      dataDirPlaceholder: '留空使用 %LOCALAPPDATA%\\dsh-neo4j-memory',
      dataDirHint: '本地 Neo4j 把数据库放在这里。如果默认位置无法启动（例如被 harness 的文件权限挡住），填写一个可写目录，例如工作区下的 .localdb；修改后需要重启 dsh 才会用新目录启动。',
      secretPlaceholder: '留空保持不变',
      clear: '清除',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      nochange: '没有需要保存的修改',
      saveFailed: '保存失败，请重试',
      unavailable: '这个配置当前不可用；请确认插件已启用。',
      loading: '正在读取配置…',
      readOnly: '当前 profile 不接受写入。',
      localNote: '本地实例会在第一次调用记忆工具时下载并启动，dsh 退出时停止。数据目录由上面的「本地数据目录」决定；留空时为 %LOCALAPPDATA%\\dsh-neo4j-memory。',
      keysNote: 'Key 由 DSH 凭据服务保存；非空环境变量优先于已保存的 Key。',
      secretHint: '已保存的 Key 不会回显；留空表示保持不变。清除只删除保存值，不影响环境变量。',
      credentialUnavailable: 'DSH 凭据服务暂不可用，无法保存 Key。',
      migrationPending: '旧配置中的 Key 尚未全部迁移；请重新保存对应 Key，或稍后重试。',
      credentialEnv: '当前使用环境变量',
      credentialSaved: '已配置',
      credentialEmpty: '未配置',
      graphTitle: '记忆图谱',
      graphIntro: '只读视图：读取插件自己的 Neo4j 里的事件、人物、概念与地点，在本地计算布局。',
      graphExpand: '展开图谱',
      graphFrameTitle: 'Neo4j 记忆图谱',
      graphFrameHint: '图谱默认不加载。展开后会打开一个占满窗口的只读视图，搜索、节点筛选和详情面板都在那里。',
      databaseSection: '数据库',
      modelSection: '模型',
      keysToggle: 'API Key',
      keysToggleHint: '提取、向量与概念对齐；默认折叠，已保存的 Key 不会回显。',
      modelEndpointsToggle: '模型端点与阈值',
      modelEndpointsHint: '自定义 Base URL、模型名、向量维度与概念对齐阈值；留空使用默认值。',
      extractionService: '提取模型',
      embeddingService: '向量模型',
      alignmentService: '概念对齐',
      baseUrl: 'Base URL',
      modelName: '模型名',
      alignmentEndpoint: '对齐接口地址',
      alignmentThreshold: '概念对齐阈值',
      alignmentThresholdHint: '同一性概率达到该值，且其他候选的差异概率至少低 5 个百分点时复用已有概念。默认 95%；调低会更积极合并。仅在开启概念对齐时生效。',
      alignmentEndpointHint: '对齐接口填完整地址：TypeSafe 默认 https://api.typesafe.ai/v1/systemone；OpenRouter 用 https://openrouter.ai/api/alpha/decisions。',
      invalidBaseUrl: 'Base URL 必须以 http:// 或 https:// 开头。',
      invalidDimensions: '向量维度必须是 1–4096 之间的整数。',
      embeddingDimensions: '向量维度',
      embeddingDimensionsHint: '必须与向量模型实际返回的维度一致（例如 1024）。模型或维度变化后，已有向量不能直接比较，需要重新向量化。',
      embeddingStatus: '向量索引',
      embeddingStatusUnknown: '展开后读取当前向量状态。',
      embeddingStatusEmpty: '还没有写入记忆；首次保存时会按当前模型和维度建立索引。',
      embeddingStatusMatch: '当前库：{model} · {dimensions} 维 · {nodes} 个节点，与配置一致。',
      embeddingStatusLegacy: '当前库是旧版本写入的（没有模型记录），{dimensions} 维与配置一致，可以直接使用。',
      embeddingStatusMismatch: '当前库：{model} · {dimensions} 维；配置：{configuredModel} · {configuredDimensions} 维。两者不一致，保存和语义搜索会被拒绝，请先重新向量化。',
      embeddingStatusMixed: '当前库的向量维度不一致（{dimensions}），需要重新向量化。',
      embeddingStatusUnavailable: '读取向量状态失败；请确认 Neo4j 已启动。',
      reembed: '重新向量化',
      reembedBusy: '重新向量化中…',
      reembedConfirm: '将用当前配置的向量模型重新计算 {nodes} 个节点的向量并重建索引，期间不能保存或搜索。继续？',
      reembedDone: '已重新向量化 {nodes} 个节点。',
      reembedFailed: '重新向量化失败；请检查向量模型 Key 与端点后重试。',
      reembedSaveFirst: '先保存向量模型/维度，再重新向量化。',
      refresh: '刷新',
      close: '关闭',
    }

    const en = {
      nav: 'Neo4j Memory',
      title: 'Neo4j Memory',
      intro: 'View the read-only memory graph and configure a local or external Neo4j plus model keys. With no password configured, the plugin uses a local Neo4j downloaded on first use.',
      mode: 'Neo4j mode',
      modeAuto: 'Auto (local unless an external connection is configured)',
      modeManaged: 'Local Neo4j only',
      modeExternal: 'External Neo4j only',
      conceptAlignment: 'Align concepts before writing',
      conceptAlignmentHint: 'Calls TypeSafe to decide whether a concept is the same as an existing one. Turn it off to skip that call and reuse concepts only by exact name or alias; the alignment key is then not required.',
      apiKey: 'Extraction API key',
      embeddingApiKey: 'Embedding API key',
      alignmentApiKey: 'Concept alignment API key',
      neo4jPassword: 'External Neo4j password',
      dataDir: 'Local data folder',
      dataDirPlaceholder: 'Leave empty for %LOCALAPPDATA%\\dsh-neo4j-memory',
      dataDirHint: 'Where the local Neo4j keeps its database. If the default location cannot start (for example because the harness file policy blocks it), set a writable folder such as a workspace .localdb; restart dsh to start the database in the new folder.',
      secretPlaceholder: 'Leave empty to keep the saved value',
      clear: 'Clear',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      nochange: 'Nothing to save',
      saveFailed: 'Save failed; try again',
      unavailable: 'This configuration is unavailable; make sure the plugin is enabled.',
      loading: 'Reading configuration…',
      readOnly: 'This profile does not accept writes.',
      localNote: 'The local instance is downloaded and started on the first memory tool call and stops when dsh exits. The folder above decides where its data lives; empty means %LOCALAPPDATA%\\dsh-neo4j-memory.',
      keysNote: 'Keys are saved through DSH credentials. Non-empty environment variables override saved keys.',
      secretHint: 'Saved keys are never echoed back; leave empty to keep them. Clearing removes saved values and leaves environment variables active.',
      credentialUnavailable: 'DSH credentials are unavailable; keys cannot be saved.',
      migrationPending: 'Some legacy keys have not migrated. Save the affected keys again or retry later.',
      credentialEnv: 'Using environment variable',
      credentialSaved: 'Configured',
      credentialEmpty: 'Not configured',
      graphTitle: 'Memory graph',
      graphIntro: 'Read-only view of the events, people, concepts and places in this plugin\u2019s Neo4j; the layout is computed locally.',
      graphExpand: 'Expand graph',
      graphFrameTitle: 'Neo4j memory graph',
      graphFrameHint: 'The graph is not loaded until you expand it. Expanding opens a window-filling read-only view with search, label filters and the detail panel.',
      databaseSection: 'Database',
      modelSection: 'Model',
      keysToggle: 'API keys',
      keysToggleHint: 'Extraction, embedding and concept alignment; collapsed by default. Saved keys are never echoed back.',
      modelEndpointsToggle: 'Model endpoints and threshold',
      modelEndpointsHint: 'Override base URLs, model names, vector dimensions and the concept-alignment threshold; leave empty for defaults.',
      extractionService: 'Extraction model',
      embeddingService: 'Embedding model',
      alignmentService: 'Concept alignment',
      baseUrl: 'Base URL',
      modelName: 'Model name',
      alignmentEndpoint: 'Alignment endpoint',
      alignmentThreshold: 'Concept alignment threshold',
      alignmentThresholdHint: 'Reuse an existing concept when identity probability reaches this value and every other candidate is at least five points less likely to be different. Default 95%; lower values merge more readily. Only used while concept alignment is enabled.',
      alignmentEndpointHint: 'Use the full alignment endpoint: TypeSafe defaults to https://api.typesafe.ai/v1/systemone; OpenRouter uses https://openrouter.ai/api/alpha/decisions.',
      invalidBaseUrl: 'Base URL must start with http:// or https://.',
      invalidDimensions: 'Vector dimensions must be an integer between 1 and 4096.',
      embeddingDimensions: 'Vector dimensions',
      embeddingDimensionsHint: 'Must match the dimensions returned by the embedding model (for example 1024). After changing the model or dimensions, existing vectors are not comparable and must be re-embedded.',
      embeddingStatus: 'Vector index',
      embeddingStatusUnknown: 'Expand to read the current vector status.',
      embeddingStatusEmpty: 'No memories yet; the index is created with the current model and dimensions on the first save.',
      embeddingStatusMatch: 'Database: {model} · {dimensions} dims · {nodes} nodes, matching the configuration.',
      embeddingStatusLegacy: 'The database was written by an older version (no model metadata); its {dimensions} dims match the configuration and can be used as is.',
      embeddingStatusMismatch: 'Database: {model} · {dimensions} dims; configured: {configuredModel} · {configuredDimensions} dims. Saving and semantic search are refused until you re-vectorize.',
      embeddingStatusMixed: 'Stored vectors have inconsistent dimensions ({dimensions}); re-vectorize to repair them.',
      embeddingStatusUnavailable: 'Could not read the vector status; make sure Neo4j is running.',
      reembed: 'Re-vectorize',
      reembedBusy: 'Re-vectorizing…',
      reembedConfirm: 'Recompute the vectors of {nodes} nodes with the configured embedding model and rebuild the indexes? Saving and searching are blocked until it finishes.',
      reembedDone: 'Re-vectorized {nodes} nodes.',
      reembedFailed: 'Re-vectorization failed; check the embedding key and endpoint and try again.',
      reembedSaveFirst: 'Save the embedding model/dimensions before re-vectorizing.',
      refresh: 'Refresh',
      close: 'Close',
    }

    const pageStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '18px',
      maxWidth: '720px',
      color: 'var(--dsw-alias-label-primary)',
    }
    const titleStyle = { margin: 0, fontSize: '18px', lineHeight: 1.4, fontWeight: 600 }
    const introStyle = { margin: 0, fontSize: '13px', lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' }
    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '6px' }
    const labelRowStyle = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }
    const labelStyle = { fontSize: '13px', fontWeight: 500 }
    const hintStyle = { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
    }
    const primaryButtonStyle = {
      alignSelf: 'flex-start',
      padding: '7px 16px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-brand-primary)',
      background: 'var(--dsw-alias-brand-primary)',
      color: 'var(--dsw-alias-bg-base)',
      font: 'inherit',
      fontSize: '13px',
      cursor: 'pointer',
    }
    const linkButtonStyle = {
      padding: 0,
      border: 0,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    }

    function noticeColor(kind) {
      if (kind === 'ok') return 'var(--dsw-alias-state-success-primary)'
      if (kind === 'error') return 'var(--dsw-alias-state-error-primary)'
      return 'var(--dsw-alias-label-secondary)'
    }

    function Field(props) {
      return h('div', { style: fieldStyle },
        h('div', { style: labelRowStyle },
          h('label', { style: labelStyle, htmlFor: props.id }, props.label),
          props.onClear ? h('button', {
            type: 'button',
            style: linkButtonStyle,
            disabled: props.disabled,
            onClick: props.onClear,
          }, props.clearLabel) : null,
        ),
        h('input', {
          id: props.id,
          type: props.type || 'text',
          value: props.value,
          placeholder: props.placeholder,
          disabled: props.disabled,
          autoComplete: 'off',
          spellCheck: false,
          onChange: props.onChange,
          style: inputStyle,
        }),
        props.hint ? h('p', { style: hintStyle }, props.hint) : null,
      )
    }

    const cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      padding: '16px',
      borderRadius: '12px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
    }
    const cardHeaderStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '16px',
      flexWrap: 'wrap',
    }
    const cardTitleStyle = { margin: 0, fontSize: '14px', lineHeight: 1.4, fontWeight: 600 }
    const sectionTitleStyle = {
      margin: '4px 0 0',
      fontSize: '12px',
      fontWeight: 600,
      letterSpacing: '0.02em',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const serviceTitleStyle = { margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
    const expandButtonStyle = {
      flexShrink: 0,
      padding: '7px 14px',
      borderRadius: '7px',
      border: '1px solid var(--dsw-alias-brand-primary)',
      background: 'transparent',
      color: 'var(--dsw-alias-brand-primary)',
      font: 'inherit',
      fontSize: '12px',
      fontWeight: 500,
      cursor: 'pointer',
    }
    const disclosureStyle = {
      borderRadius: '10px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      overflow: 'hidden',
    }
    const disclosureButtonStyle = {
      width: '100%',
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '12px 14px',
      border: 0,
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer',
    }
    const disclosureLabelStyle = { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }
    const disclosureBodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      padding: '0 14px 14px',
    }

    // A native <dialog>.showModal() lives in the browser's top layer, which is the only
    // surface that can paint above the settings shell: that shell is another body portal
    // at z-index 1000, while shell.overlay itself is a child of AppFrame's z-index 20
    // stacking context, so no z-index inside this slot can rise above the settings panel.
    const graphDialogCss = [
      '.dsh-neo4j-memory-graph-dialog{box-sizing:border-box;position:fixed;inset:0;width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:clamp(8px,2vw,24px);border:0;background:transparent;color:var(--dsw-alias-label-primary);overflow:hidden;pointer-events:auto}',
      '.dsh-neo4j-memory-graph-dialog[open]{display:flex}',
      '.dsh-neo4j-memory-graph-dialog::backdrop{background:var(--dsw-alias-bg-mask-1, rgba(6,10,16,.62));backdrop-filter:var(--dsw-mask-blur, blur(6px))}',
      '.dsh-neo4j-memory-graph-panel{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 30px 90px -32px rgba(0,0,0,.7);pointer-events:auto}',
      '.dsh-neo4j-memory-graph-head{display:flex;align-items:center;justify-content:space-between;gap:16px;flex:none;padding:10px 12px 10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-neo4j-memory-graph-title{font-size:13px;font-weight:600;line-height:1.4}',
      '.dsh-neo4j-memory-graph-close{border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:20px;line-height:1;padding:4px 8px;cursor:pointer}',
      '.dsh-neo4j-memory-graph-close:hover{color:var(--dsw-alias-label-primary)}',
      '.dsh-neo4j-memory-graph-frame{flex:1;width:100%;min-height:0;border:0;background:transparent;display:block}',
    ].join('')

    // The settings page and the frame-wide overlay are two registrations of one plugin
    // instance, so a module-scoped store keeps their open state in sync.
    const graphViewerState = { open: false, listeners: new Set() }
    function setGraphViewer(open) {
      if (graphViewerState.open === open) return
      graphViewerState.open = open
      for (const listener of [...graphViewerState.listeners]) {
        try { listener() } catch { /* one stale listener must not break the toggle */ }
      }
    }
    function useGraphViewer() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((count) => count + 1)
        graphViewerState.listeners.add(listener)
        return () => { graphViewerState.listeners.delete(listener) }
      }, [])
      return graphViewerState.open
    }

    function GraphCard(props) {
      const t = props.t
      return h('div', { style: cardStyle },
        h('div', { style: cardHeaderStyle },
          h('div', { style: fieldStyle },
            h('h2', { style: cardTitleStyle }, t('graphTitle')),
            h('p', { style: hintStyle }, t('graphIntro')),
          ),
          h('button', {
            type: 'button',
            style: expandButtonStyle,
            onClick: () => setGraphViewer(true),
          }, t('graphExpand')),
        ),
        h('p', { style: hintStyle }, t('graphFrameHint')),
      )
    }

    function GraphOverlay(props) {
      const t = props.t
      const open = useGraphViewer()
      const dialog = React.useRef(null)

      // Close the native dialog before dropping React state so the browser restores
      // focus to the settings control that opened it.
      function closeGraph() {
        const node = dialog.current
        if (node && node.open) node.close()
        setGraphViewer(false)
      }

      React.useEffect(() => {
        if (!open) return undefined
        const node = dialog.current
        if (node && !node.open) {
          try { node.showModal() } catch { node.setAttribute('open', '') }
        }
        // The settings shell keeps its own document-level Esc/Tab handler while it is open.
        // The dialog is the topmost surface here, so those two keys must stay with it.
        const onKey = (event) => {
          if (event.key !== 'Escape' && event.key !== 'Tab') return
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            closeGraph()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          if (node && node.open) node.close()
        }
      }, [open])

      if (!open) return null
      return h('dialog', {
        ref: dialog,
        className: 'dsh-neo4j-memory-graph-dialog',
        'aria-label': t('graphTitle'),
        onCancel: (event) => { event.preventDefault(); closeGraph() },
        onClose: () => setGraphViewer(false),
        onClick: (event) => { if (event.target === event.currentTarget) closeGraph() },
      },
        h('style', null, graphDialogCss),
        h('div', { className: 'dsh-neo4j-memory-graph-panel' },
          h('div', { className: 'dsh-neo4j-memory-graph-head' },
            h('span', { className: 'dsh-neo4j-memory-graph-title' }, t('graphTitle')),
            h('button', {
              type: 'button',
              className: 'dsh-neo4j-memory-graph-close',
              onClick: closeGraph,
              'aria-label': t('close'),
            }, '\u00d7'),
          ),
          h('iframe', {
            src: GRAPH_URL,
            title: t('graphFrameTitle'),
            className: 'dsh-neo4j-memory-graph-frame',
            allow: 'clipboard-write',
          }),
        ),
      )
    }

    function SettingsPage(props) {
      const form = props.form
      const t = props.t
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      const [draft, setDraft] = React.useState({
        conceptAlignment: true,
        neo4jMode: 'auto',
        dataDir: '',
        extractionBaseUrl: '',
        extractionModel: '',
        embeddingBaseUrl: '',
        embeddingModel: '',
        embeddingDimensions: 1024,
        alignmentBaseUrl: '',
        alignmentModel: '',
        alignmentThreshold: DEFAULT_ALIGNMENT_THRESHOLD,
        apiKey: '',
        embeddingApiKey: '',
        alignmentApiKey: '',
        neo4jPassword: '',
      })
      const [touched, setTouched] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [keysOpen, setKeysOpen] = React.useState(false)
      const [endpointsOpen, setEndpointsOpen] = React.useState(false)
      const [embedding, setEmbedding] = React.useState(null)
      const [embeddingBusy, setEmbeddingBusy] = React.useState(false)
      const [embeddingError, setEmbeddingError] = React.useState('')
      const [credentialStatus, setCredentialStatus] = React.useState(null)
      const [credentialError, setCredentialError] = React.useState(false)

      const credentialRequest = async (values) => {
        const response = await fetch('/dsh-neo4j-memory/credentials', values === undefined ? {
          cache: 'no-store', headers: { accept: 'application/json' },
        } : {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-neo4j-memory-action': 'credentials' },
          body: JSON.stringify(values),
        })
        const body = await response.json().catch(() => null)
        if (!response.ok || !body?.ok) throw new Error('Credentials unavailable')
        setCredentialStatus(body.data)
        setCredentialError(false)
        return body.data
      }
      React.useEffect(() => { void credentialRequest().catch(() => setCredentialError(true)) }, [])
      const secretHint = (field) => {
        const state = credentialStatus?.secrets?.[field]
        const status = state?.source === 'env' ? t('credentialEnv') : state?.configured ? t('credentialSaved') : t('credentialEmpty')
        return `${status} · ${t('secretHint')}`
      }
      const secretDisabled = busy || snapshot.writable === false || !credentialStatus?.writable

      React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form])

      React.useEffect(() => {
        if (touched) return
        const value = snapshot.value || {}
        setDraft((current) => {
          const next = {
            ...current,
            neo4jMode: MODES.includes(value.neo4jMode) ? value.neo4jMode : 'auto',
            conceptAlignment: value.conceptAlignment !== false,
            dataDir: typeof value.dataDir === 'string' ? value.dataDir : '',
            alignmentThreshold: typeof value.alignmentThreshold === 'number' ? value.alignmentThreshold : DEFAULT_ALIGNMENT_THRESHOLD,
            embeddingDimensions: typeof value.embeddingDimensions === 'number' ? value.embeddingDimensions : 1024,
          }
          for (const field of MODEL_FIELDS) next[field] = typeof value[field] === 'string' ? value[field] : ''
          return next
        })
      }, [snapshot.value, touched])

      const refreshEmbedding = async () => {
        try {
          const response = await fetch('/dsh-neo4j-memory/embedding-status', { cache: 'no-store', headers: { accept: 'application/json' } })
          const body = await response.json().catch(() => null)
          if (!response.ok || !body?.ok) throw new Error(body?.error || 'unavailable')
          setEmbedding(body.data)
          setEmbeddingError('')
        } catch {
          setEmbedding(null)
          setEmbeddingError(t('embeddingStatusUnavailable'))
        }
      }
      // Reading the status starts the backend; only do it once the model section is opened.
      React.useEffect(() => { if (endpointsOpen) void refreshEmbedding() }, [endpointsOpen])

      const writable = snapshot.writable !== false
      const disabled = busy || !writable
      const update = (field) => (event) => {
        setTouched(true)
        setNotice(null)
        const next = event.target.type === 'checkbox' ? event.target.checked : event.target.value
        setDraft((current) => ({ ...current, [field]: next }))
      }
      const updateNumber = (field) => (event) => {
        setTouched(true)
        setNotice(null)
        const next = Number(event.target.value)
        if (Number.isFinite(next)) setDraft((current) => ({ ...current, [field]: Math.round(next * 100) / 100 }))
      }
      const updateDimensions = (event) => {
        setTouched(true)
        setNotice(null)
        const raw = event.target.value
        setDraft((current) => ({ ...current, embeddingDimensions: raw === '' ? '' : Number(raw) }))
      }

      const save = async () => {
        if (!writable) return
        const value = snapshot.value || {}
        const dimensions = Number(draft.embeddingDimensions)
        if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) {
          setNotice({ kind: 'error', text: t('invalidDimensions') })
          return
        }
        for (const field of BASE_URL_FIELDS) {
          const next = String(draft[field] || '').trim()
          if (next === '') continue
          let valid = false
          try {
            const url = new URL(next)
            valid = (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) && !url.username && !url.password
          } catch { /* invalid URL text */ }
          if (!valid) {
            setNotice({ kind: 'error', text: t('invalidBaseUrl') })
            return
          }
        }
        const ops = []
        if (draft.neo4jMode !== (value.neo4jMode || 'auto')) {
          ops.push({ op: 'set', path: ['neo4jMode'], value: draft.neo4jMode })
        }
        if (draft.conceptAlignment !== (value.conceptAlignment !== false)) {
          ops.push({ op: 'set', path: ['conceptAlignment'], value: draft.conceptAlignment })
        }
        if (draft.dataDir !== (value.dataDir || '')) {
          ops.push({ op: 'set', path: ['dataDir'], value: draft.dataDir })
        }
        for (const field of MODEL_FIELDS) {
          const next = String(draft[field] || '').trim()
          if (next !== (typeof value[field] === 'string' ? value[field] : '')) {
            ops.push({ op: 'set', path: [field], value: next })
          }
        }
        const storedDimensions = typeof value.embeddingDimensions === 'number' ? value.embeddingDimensions : 1024
        if (dimensions !== storedDimensions) {
          ops.push({ op: 'set', path: ['embeddingDimensions'], value: dimensions })
        }
        const storedThreshold = typeof value.alignmentThreshold === 'number' ? value.alignmentThreshold : DEFAULT_ALIGNMENT_THRESHOLD
        if (draft.alignmentThreshold !== storedThreshold) {
          ops.push({ op: 'set', path: ['alignmentThreshold'], value: draft.alignmentThreshold })
        }
        const secrets = {}
        for (const field of SECRET_FIELDS) {
          if (draft[field].trim() !== '') secrets[field] = draft[field].trim()
        }
        if (ops.length === 0 && Object.keys(secrets).length === 0) {
          setNotice({ kind: 'info', text: t('nochange') })
          return
        }
        setBusy(true)
        setNotice(null)
        try {
          // Key values go only to the write-only credential endpoint, never to Config.
          if (Object.keys(secrets).length) await credentialRequest(secrets)
          const ok = ops.length === 0 || await form.mutate(ops)
          if (ok) {
            setDraft((current) => ({ ...current, apiKey: '', embeddingApiKey: '', alignmentApiKey: '', neo4jPassword: '' }))
            setTouched(false)
            setNotice({ kind: 'ok', text: t('saved') })
            if (endpointsOpen) void refreshEmbedding()
          } else {
            setNotice({ kind: 'error', text: t('saveFailed') })
          }
        } catch {
          setNotice({ kind: 'error', text: t('saveFailed') })
        } finally {
          setBusy(false)
        }
      }

      const clear = async (field) => {
        if (secretDisabled) return
        setBusy(true)
        setNotice(null)
        try {
          await credentialRequest({ [field]: null })
          setDraft((current) => ({ ...current, [field]: '' }))
          setNotice({ kind: 'ok', text: t('saved') })
        } catch {
          setNotice({ kind: 'error', text: t('saveFailed') })
        } finally {
          setBusy(false)
        }
      }

      const runReembed = async () => {
        const count = embedding?.nodes ?? 0
        if (!window.confirm(t('reembedConfirm').replace('{nodes}', String(count)))) return
        setEmbeddingBusy(true)
        setEmbeddingError('')
        try {
          const response = await fetch('/dsh-neo4j-memory/reembed', {
            method: 'POST',
            headers: { accept: 'application/json', 'x-dsh-neo4j-memory-action': 'reembed' },
          })
          const body = await response.json().catch(() => null)
          if (!response.ok || !body?.ok) throw new Error(body?.error || 'failed')
          setNotice({ kind: 'ok', text: t('reembedDone').replace('{nodes}', String(body.data?.nodes ?? count)) })
          await refreshEmbedding()
        } catch {
          setEmbeddingError(t('reembedFailed'))
        } finally {
          setEmbeddingBusy(false)
        }
      }

      if (snapshot.status === 'loading') {
        return h('section', { style: pageStyle }, h('p', { style: introStyle }, t('loading')))
      }
      if (snapshot.status === 'unavailable') {
        return h('section', { style: pageStyle },
          h('h1', { style: titleStyle }, t('title')),
          h('p', { style: hintStyle }, t('unavailable')),
        )
      }

      const modeOptions = MODES.map((mode) =>
        h('option', { key: mode, value: mode }, t('mode' + mode.charAt(0).toUpperCase() + mode.slice(1))))

      const storedDimensions = typeof snapshot.value?.embeddingDimensions === 'number' ? snapshot.value.embeddingDimensions : 1024
      const embeddingDirty = Number(draft.embeddingDimensions) !== storedDimensions
        || String(draft.embeddingModel || '').trim() !== String(snapshot.value?.embeddingModel || '').trim()
      let embeddingText = t('embeddingStatusUnknown')
      if (embeddingError) embeddingText = embeddingError
      else if (embedding) {
        if ((embedding.detected_dimensions || []).length > 1) embeddingText = t('embeddingStatusMixed').replace('{dimensions}', embedding.detected_dimensions.join(', '))
        else if (!embedding.compatible) embeddingText = t('embeddingStatusMismatch')
          .replace('{model}', embedding.model || '?').replace('{dimensions}', String(embedding.dimensions ?? '?'))
          .replace('{configuredModel}', embedding.configured?.model || '?').replace('{configuredDimensions}', String(embedding.configured?.dimensions ?? '?'))
        else if (embedding.nodes === 0) embeddingText = t('embeddingStatusEmpty')
        else if (embedding.legacy) embeddingText = t('embeddingStatusLegacy').replace('{dimensions}', String(embedding.dimensions))
        else embeddingText = t('embeddingStatusMatch')
          .replace('{model}', embedding.model || '?').replace('{dimensions}', String(embedding.dimensions ?? '?')).replace('{nodes}', String(embedding.nodes))
      }
      const embeddingBlock = h('div', { style: fieldStyle },
        h('div', { style: labelRowStyle },
          h('span', { style: labelStyle }, t('embeddingStatus')),
          h('button', {
            type: 'button',
            style: linkButtonStyle,
            disabled: embeddingBusy,
            onClick: () => void refreshEmbedding(),
          }, t('refresh')),
        ),
        h('p', { style: { ...hintStyle, margin: 0 } }, embeddingText),
        embeddingDirty ? h('p', { style: hintStyle }, t('reembedSaveFirst')) : null,
        h('button', {
          type: 'button',
          style: primaryButtonStyle,
          disabled: disabled || embeddingBusy || embeddingDirty || !embedding,
          onClick: runReembed,
        }, embeddingBusy ? t('reembedBusy') : t('reembed')),
      )

      return h('section', { style: pageStyle },
        h('div', { style: fieldStyle },
          h('h1', { style: titleStyle }, t('title')),
          h('p', { style: introStyle }, t('intro')),
        ),
        h(GraphCard, { t }),
        h('h2', { style: sectionTitleStyle }, t('databaseSection')),
        h('div', { style: fieldStyle },
          h('label', { style: labelStyle, htmlFor: 'dsh-neo4j-memory-mode' }, t('mode')),
          h('select', {
            id: 'dsh-neo4j-memory-mode',
            value: draft.neo4jMode,
            disabled,
            onChange: update('neo4jMode'),
            style: inputStyle,
          }, modeOptions),
        ),
        h(Field, {
          id: 'dsh-neo4j-memory-password',
          label: t('neo4jPassword'),
          type: 'password',
          value: draft.neo4jPassword,
          placeholder: t('secretPlaceholder'),
          disabled: secretDisabled,
          hint: secretHint('neo4jPassword'),
          onChange: update('neo4jPassword'),
          onClear: () => clear('neo4jPassword'),
          clearLabel: t('clear'),
        }),
        h(Field, {
          id: 'dsh-neo4j-memory-data-dir',
          label: t('dataDir'),
          value: draft.dataDir,
          placeholder: t('dataDirPlaceholder'),
          disabled,
          onChange: update('dataDir'),
          hint: t('dataDirHint'),
        }),
        h('p', { style: hintStyle }, t('localNote')),
        h('h2', { style: sectionTitleStyle }, t('modelSection')),
        h('div', { style: fieldStyle },
          h('label', {
            style: { ...labelStyle, display: 'flex', alignItems: 'center', gap: '8px' },
            htmlFor: 'dsh-neo4j-memory-concept-alignment',
          },
            h('input', {
              id: 'dsh-neo4j-memory-concept-alignment',
              type: 'checkbox',
              checked: draft.conceptAlignment,
              disabled,
              onChange: update('conceptAlignment'),
            }),
            t('conceptAlignment'),
          ),
          h('p', { style: hintStyle }, t('conceptAlignmentHint')),
        ),
        h('div', { style: disclosureStyle },
          h('button', {
            type: 'button',
            style: disclosureButtonStyle,
            'aria-expanded': keysOpen,
            'aria-controls': 'dsh-neo4j-memory-keys',
            onClick: () => setKeysOpen((open) => !open),
          },
            h('span', { style: disclosureLabelStyle },
              h('span', { style: labelStyle }, t('keysToggle')),
              h('span', { style: hintStyle }, t('keysToggleHint')),
            ),
            h('span', {
              'aria-hidden': true,
              style: {
                flexShrink: 0,
                fontSize: '18px',
                lineHeight: 1,
                color: 'var(--dsw-alias-label-secondary)',
                transform: keysOpen ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.15s ease',
              },
            }, '\u203a'),
          ),
          keysOpen ? h('div', { id: 'dsh-neo4j-memory-keys', style: disclosureBodyStyle },
            h(Field, {
              id: 'dsh-neo4j-memory-api-key',
              label: t('apiKey'),
              type: 'password',
              value: draft.apiKey,
              placeholder: t('secretPlaceholder'),
              disabled: secretDisabled,
              onChange: update('apiKey'),
              onClear: () => clear('apiKey'),
              clearLabel: t('clear'),
              hint: secretHint('apiKey'),
            }),
            h(Field, {
              id: 'dsh-neo4j-memory-embedding-key',
              label: t('embeddingApiKey'),
              type: 'password',
              value: draft.embeddingApiKey,
              placeholder: t('secretPlaceholder'),
              disabled: secretDisabled,
              onChange: update('embeddingApiKey'),
              onClear: () => clear('embeddingApiKey'),
              clearLabel: t('clear'),
              hint: secretHint('embeddingApiKey'),
            }),
            h(Field, {
              id: 'dsh-neo4j-memory-alignment-key',
              label: t('alignmentApiKey'),
              type: 'password',
              value: draft.alignmentApiKey,
              placeholder: t('secretPlaceholder'),
              disabled: secretDisabled,
              onChange: update('alignmentApiKey'),
              onClear: () => clear('alignmentApiKey'),
              clearLabel: t('clear'),
              hint: secretHint('alignmentApiKey'),
            }),
            h('p', { style: hintStyle }, t('keysNote')),
          ) : null,
        ),
        h('div', { style: disclosureStyle },
          h('button', {
            type: 'button',
            style: disclosureButtonStyle,
            'aria-expanded': endpointsOpen,
            'aria-controls': 'dsh-neo4j-memory-model-endpoints',
            onClick: () => setEndpointsOpen((open) => !open),
          },
            h('span', { style: disclosureLabelStyle },
              h('span', { style: labelStyle }, t('modelEndpointsToggle')),
              h('span', { style: hintStyle }, t('modelEndpointsHint')),
            ),
            h('span', {
              'aria-hidden': true,
              style: {
                flexShrink: 0,
                fontSize: '18px',
                lineHeight: 1,
                color: 'var(--dsw-alias-label-secondary)',
                transform: endpointsOpen ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.15s ease',
              },
            }, '\u203a'),
          ),
          endpointsOpen ? h('div', { id: 'dsh-neo4j-memory-model-endpoints', style: disclosureBodyStyle },
            h('h3', { style: serviceTitleStyle }, t('extractionService')),
            h(Field, {
              id: 'dsh-neo4j-memory-extraction-base-url',
              label: t('baseUrl'),
              value: draft.extractionBaseUrl,
              placeholder: MODEL_PLACEHOLDERS.extractionBaseUrl,
              disabled,
              onChange: update('extractionBaseUrl'),
            }),
            h(Field, {
              id: 'dsh-neo4j-memory-extraction-model',
              label: t('modelName'),
              value: draft.extractionModel,
              placeholder: MODEL_PLACEHOLDERS.extractionModel,
              disabled,
              onChange: update('extractionModel'),
            }),
            h('h3', { style: serviceTitleStyle }, t('embeddingService')),
            h(Field, {
              id: 'dsh-neo4j-memory-embedding-base-url',
              label: t('baseUrl'),
              value: draft.embeddingBaseUrl,
              placeholder: MODEL_PLACEHOLDERS.embeddingBaseUrl,
              disabled,
              onChange: update('embeddingBaseUrl'),
            }),
            h(Field, {
              id: 'dsh-neo4j-memory-embedding-model',
              label: t('modelName'),
              value: draft.embeddingModel,
              placeholder: MODEL_PLACEHOLDERS.embeddingModel,
              disabled,
              onChange: update('embeddingModel'),
            }),
            h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'dsh-neo4j-memory-embedding-dimensions' }, t('embeddingDimensions')),
              h('input', {
                id: 'dsh-neo4j-memory-embedding-dimensions',
                type: 'number',
                min: 1,
                max: 4096,
                step: 1,
                list: 'dsh-neo4j-memory-dimension-presets',
                value: draft.embeddingDimensions,
                disabled,
                onChange: updateDimensions,
                style: inputStyle,
              }),
              h('datalist', { id: 'dsh-neo4j-memory-dimension-presets' },
                [512, 768, 1024, 1536, 2048, 3072, 4096].map((value) =>
                  h('option', { key: value, value: String(value) }))),
              h('p', { style: hintStyle }, t('embeddingDimensionsHint')),
            ),
            embeddingBlock,
            h('h3', { style: serviceTitleStyle }, t('alignmentService')),
            h(Field, {
              id: 'dsh-neo4j-memory-alignment-base-url',
              label: t('alignmentEndpoint'),
              value: draft.alignmentBaseUrl,
              placeholder: MODEL_PLACEHOLDERS.alignmentBaseUrl,
              disabled,
              onChange: update('alignmentBaseUrl'),
              hint: t('alignmentEndpointHint'),
            }),
            h(Field, {
              id: 'dsh-neo4j-memory-alignment-model',
              label: t('modelName'),
              value: draft.alignmentModel,
              placeholder: MODEL_PLACEHOLDERS.alignmentModel,
              disabled,
              onChange: update('alignmentModel'),
            }),
            h('div', { style: fieldStyle },
              h('div', { style: labelRowStyle },
                h('label', { style: labelStyle, htmlFor: 'dsh-neo4j-memory-alignment-threshold' }, t('alignmentThreshold')),
                h('span', {
                  style: { fontSize: '12px', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)' },
                }, `${Math.round(draft.alignmentThreshold * 100)}%`),
              ),
              h('input', {
                id: 'dsh-neo4j-memory-alignment-threshold',
                type: 'range',
                min: 0.8,
                max: 0.99,
                step: 0.01,
                value: draft.alignmentThreshold,
                disabled,
                onChange: updateNumber('alignmentThreshold'),
                style: { width: '100%', accentColor: 'var(--dsw-alias-brand-primary)' },
              }),
              h('p', { style: hintStyle }, t('alignmentThresholdHint')),
            ),
          ) : null,
        ),
        !writable ? h('p', { style: hintStyle }, t('readOnly')) : null,
        credentialError || credentialStatus?.writable === false ? h('p', { style: hintStyle }, t('credentialUnavailable'), ' ',
          h('button', { type: 'button', style: linkButtonStyle, disabled: busy,
            onClick: () => { void credentialRequest().catch(() => setCredentialError(true)) },
          }, t('refresh')),
        ) : null,
        credentialStatus?.migrationPending ? h('p', { style: hintStyle }, t('migrationPending')) : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('button', {
            type: 'button',
            style: primaryButtonStyle,
            disabled,
            onClick: save,
          }, busy ? t('saving') : t('save')),
          notice ? h('span', { style: { fontSize: '12px', color: noticeColor(notice.kind) } }, notice.text) : null,
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-neo4j-memory: dictionaries')
        const form = ctx.configForms.get(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-neo4j-memory',
          order: 16,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ form, t }),
        }, SettingsPage))

        // The graph needs a canvas wider than the settings column, so the page keeps it out
        // of flow until this seat opens a top-layer dialog over the whole window.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-neo4j-memory-graph-overlay',
          order: 60,
          inject: () => ({ t }),
        }, GraphOverlay))
      },
    }
  },
})
