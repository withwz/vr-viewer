/* VR Viewer 业务逻辑 — 纯静态,无 framework 依赖
 *
 * v2 (2026-06-12): 加防御性 instrumentation,所有关键步骤打 console.log,
 *                  ready 加 10s 兜底 timeout,error 态可点击重试。
 *                  防止 PSV 内部静默失败时 iframe 显示黑屏但无任何线索。
 */
(function () {
  'use strict'

  // ============ 日志辅助 ============
  var LOG_PREFIX = '[vr-viewer]'
  function log() {
    var args = Array.prototype.slice.call(arguments)
    args.unshift(LOG_PREFIX)
    console.log.apply(console, args)
  }
  function warn() {
    var args = Array.prototype.slice.call(arguments)
    args.unshift(LOG_PREFIX)
    console.warn.apply(console, args)
  }

  // ============ 配置 ============
  // API 基础地址。通过 URL query `apiBase` 传入（iframe/web-view 通用）。
  // 无此参数时回退硬编码默认值，部署时按环境修改此行。
  var VR_API_BASE =
    new URLSearchParams(window.location.search).get('apiBase') ||
    'http://10.10.44.103:37056'

  // ============ 数据 ============
  // 场景数据由 Vue 组件通过 srcdoc 占位符 __VR_SCENES__ 注入,
  // 不再使用硬编码的 SHOWROOMS。格式参考: VrScene[]
  var viewer = null
  var currentScenes = null

  // ============ DOM 引用 ============
  var loadingEl = document.getElementById('loading')
  var errorEl = document.getElementById('error')
  var containerEl = document.getElementById('psv-container')
  var thumbsBarEl = document.getElementById('thumbs-bar')

  log('DOM ready:', {
    loading: !!loadingEl,
    error: !!errorEl,
    container: !!containerEl,
    thumbsBar: !!thumbsBarEl,
    containerSize: containerEl && {
      w: containerEl.offsetWidth,
      h: containerEl.offsetHeight
    }
  })

  // ============ 工具函数 ============
  function showError(msg) {
    warn('error:', msg)
    if (loadingEl) loadingEl.hidden = true
    if (containerEl) containerEl.hidden = true
    if (thumbsBarEl) thumbsBarEl.hidden = true
    if (errorEl) {
      errorEl.hidden = false
      errorEl.textContent = msg + '  (点击重试)'
      errorEl.style.cursor = 'pointer'
      errorEl.onclick = function () { window.location.reload() }
    }
  }

  function hideLoading() {
    log('hideLoading() called')
    if (loadingEl) loadingEl.hidden = true
  }

  // ============ 主流程 ============
  log('script executed, photoSphereViewer type =', typeof photoSphereViewer)
  if (typeof photoSphereViewer === 'undefined' || !photoSphereViewer.Viewer) {
    showError('viewer 库加载失败,请检查 lib/photo-sphere-viewer.bundle.js')
    return
  }
  log('photoSphereViewer.Viewer version =', photoSphereViewer.VERSION)

  var id = window.__VR_SCENE_ID__ || new URLSearchParams(window.location.search).get('id') || ''
  log('id =', JSON.stringify(id), 'source =', window.__VR_SCENE_ID__ ? 'global(srcdoc)' : 'url(standalone)')
  if (!id) {
    showError('缺少参数:id')
    return
  }

  // 优先从 #vr-data 读取(srcdoc 模式),否则从 API 获取(独立 URL 模式)
  var vrDataEl = document.getElementById('vr-data')
  if (vrDataEl) {
    var vrData = JSON.parse(vrDataEl.textContent)
    initViewer(vrData.scenes, vrData.name || 'VR 样板间')
  } else {
    log('vr-data not found, fetching from API...')
    fetchShowroomDetail(id)
  }

  function fetchShowroomDetail(showroomId) {
    var apiUrl = VR_API_BASE + '/api/vr/detail/' + showroomId
    log('fetching showroom detail:', apiUrl)
    fetch(apiUrl)
      .then(function (res) { return res.json() })
      .then(function (json) {
        if (json.code === 0 && json.data && json.data.scenes) {
          initViewer(json.data.scenes, json.data.name || 'VR 样板间')
        } else {
          showError('场景数据加载失败')
        }
      })
      .catch(function (err) {
        warn('fetch showroom detail failed:', err)
        showError('网络请求失败')
      })
  }

  function initViewer(scenes, showroomName) {
    if (!scenes || !scenes.length) {
      showError('场景数据缺失')
      return
    }
    log('showroom =', showroomName, 'scenes =', scenes.length)
    document.title = showroomName
    currentScenes = scenes

    var defaultScene = scenes.find(function (s) { return s.isDefault }) || scenes[0]
    log('default scene =', defaultScene)

    try {
      log('calling new photoSphereViewer.Viewer with panorama =', defaultScene.image)
      viewer = new photoSphereViewer.Viewer({
        container: containerEl,
        panorama: defaultScene.image,
        navbar: ['zoom', 'move', 'fullscreen'],
        defaultZoomLvl: 0,
        loadingTxt: '加载中…'
      })
      log('Viewer constructed:', viewer)
    } catch (err) {
      showError('viewer 初始化失败:' + (err && err.message || err))
      return
    }

    // PSV ready event
    viewer.addEventListener('ready', function () {
      log('PSV ready event fired')
      hideLoading()
    })
    viewer.addEventListener('panorama-load', function () {
      log('PSV panorama-load event fired (texture ready)')
    })
    viewer.addEventListener('panorama-error', function (e) {
      var detail = e && (e.details || e) || {}
      warn('PSV panorama-error event fired', { type: e && e.type, detail: detail })
      showError('全景图加载失败: ' + (detail.panorama || defaultScene.image))
    })

    // 兜底:10s 后强制隐藏 loading
    setTimeout(function () {
      if (loadingEl && !loadingEl.hidden) {
        warn('ready event 未在 10s 内触发,强制隐藏 loading')
        hideLoading()
      }
    }, 10000)

    // 缩略图条
    renderThumbs(scenes, defaultScene.id)
  }

  function renderThumbs(scenesList, activeId) {
    // 始终显示缩略图条,1 个场景时也展示当前场景缩略图,防止底部黑条
    thumbsBarEl.hidden = false
    thumbsBarEl.innerHTML = ''
    scenesList.forEach(function (s) {
      var btn = document.createElement('button')
      btn.className = 'vr-thumb' + (s.id === activeId ? ' active' : '')
      btn.type = 'button'
      btn.dataset.sceneId = s.id
      btn.innerHTML =
        '<img src="' + s.image + '" alt="' + s.name + '" />' +
        '<span class="vr-thumb-name">' + s.name + '</span>'
      btn.addEventListener('click', function () {
        switchScene(s.id)
      })
      thumbsBarEl.appendChild(btn)
    })
  }

  function switchScene(sceneId) {
    if (!currentScenes) return
    var s = currentScenes.find(function (x) { return x.id === sceneId })
    if (!s || !viewer) return
    log('switchScene →', s.id, s.image)
    setActiveThumb(sceneId)
    viewer.setPanorama(s.image).catch(function (err) {
      warn('setPanorama failed:', err)
    })
  }

  function setActiveThumb(sceneId) {
    var btns = thumbsBarEl.querySelectorAll('.vr-thumb')
    btns.forEach(function (b) {
      b.classList.toggle('active', b.dataset.sceneId === sceneId)
    })
  }

  // ============ 清理 ============
  window.addEventListener('beforeunload', function () {
    if (viewer) {
      try { viewer.destroy() } catch (_) {}
      viewer = null
    }
  })

  window.__vrViewer = viewer
  log('window.__vrViewer assigned for debugging')
})();
