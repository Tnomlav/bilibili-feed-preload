// ==UserScript==
// @name         B站预刷新
// @namespace    https://github.com/Tnomlav/bilibili-feed-preload
// @version      1.2.0
// @description  为 B站首页换一换提供后台预载、状态提示和自定义快捷键。
// @author       Tnomlav
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// @homepageURL  https://github.com/Tnomlav/bilibili-feed-preload
// @supportURL   https://github.com/Tnomlav/bilibili-feed-preload/issues
// @downloadURL  https://github.com/Tnomlav/bilibili-feed-preload/releases/latest/download/bilibili-feed-preload.user.js
// @updateURL    https://github.com/Tnomlav/bilibili-feed-preload/releases/latest/download/bilibili-feed-preload.user.js
// @match        https://www.bilibili.com/
// @match        https://www.bilibili.com/index.html
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(() => {
    'use strict'

    const HOME_URL = 'https://www.bilibili.com/'
    const FRAME_CLASS = 'bili-feed-preload-frame'
    const BUSY_ID = 'bili-feed-preload-busy'
    const STYLE_ID = 'bili-feed-preload-style'
    const MODE_ATTRIBUTE = 'data-bili-feed-preload-active'
    const STATE_ATTRIBUTE = 'data-bili-feed-preload-state'
    const SETTINGS_HOST_ID = 'bili-feed-preload-settings'
    const SETTINGS_KEY = 'bili-feed-preload.settings'
    const MIN_CARD_COUNT = 18
    const READY_TIMEOUT_MS = 12_000
    const CLICK_WAIT_MS = 800
    const CLICK_COOLDOWN_MS = 1_500
    const READY_POLL_MS = 150

    let activeFrame = null
    let nextFrame = null
    let preparing = null
    let activeReady = false
    let switching = false
    let recoveryScheduled = false
    let cooldownUntil = 0
    let toastTimer = 0
    let capturingShortcut = false
    let settingsHost = null
    let shortcutButton = null
    let shortcutToggle = null
    let statusNode = null

    const defaultShortcut = {
        code: 'KeyR',
        key: 'r',
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
    }

    const readSettings = () => {
        try {
            const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
            return {
                shortcutEnabled: stored.shortcutEnabled !== false,
                shortcut: {
                    ...defaultShortcut,
                    ...(stored.shortcut || {}),
                },
            }
        } catch {
            return {
                shortcutEnabled: true,
                shortcut: { ...defaultShortcut },
            }
        }
    }

    const settings = readSettings()

    const saveSettings = () => {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
        } catch {
            showToast('设置保存失败')
        }
    }

    const formatShortcut = (shortcut = settings.shortcut) => {
        const parts = []
        if (shortcut.ctrl) parts.push('Ctrl')
        if (shortcut.alt) parts.push('Alt')
        if (shortcut.shift) parts.push('Shift')
        if (shortcut.meta) parts.push('Meta')
        let keyName = shortcut.key || shortcut.code || '?'
        if (keyName.length === 1) {
            keyName = keyName.toUpperCase()
        }
        parts.push(keyName)
        return parts.join('+')
    }

    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

    const isHomePage = () => {
        return (
            location.hostname === 'www.bilibili.com' &&
            (location.pathname === '/' || location.pathname === '/index.html')
        )
    }

    const isRollTarget = (target) => {
        return Boolean(
            target &&
                typeof target.closest === 'function' &&
                target.closest('.roll-btn, .feed-roll-btn'),
        )
    }

    const isEditableNode = (node) => {
        if (!node) {
            return false
        }
        const tagName = node.tagName?.toLowerCase?.()
        if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
            return true
        }
        if (node.isContentEditable) {
            return true
        }
        return Boolean(
            typeof node.closest === 'function' &&
                node.closest(
                    '[contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"]',
                ),
        )
    }

    const shouldTriggerShortcut = (event, doc) => {
        if (
            !settings.shortcutEnabled ||
            capturingShortcut ||
            event.repeat ||
            event.isComposing ||
            event.keyCode === 229 ||
            event.ctrlKey !== settings.shortcut.ctrl ||
            event.altKey !== settings.shortcut.alt ||
            event.shiftKey !== settings.shortcut.shift ||
            event.metaKey !== settings.shortcut.meta
        ) {
            return false
        }

        const keyMatches = settings.shortcut.code
            ? event.code === settings.shortcut.code
            : event.key?.toLowerCase() === settings.shortcut.key?.toLowerCase()
        if (!keyMatches) {
            return false
        }

        const path = typeof event.composedPath === 'function' ? event.composedPath() : []
        return ![...path, event.target, doc.activeElement].some(isEditableNode)
    }

    const bindShortcuts = (doc) => {
        doc.addEventListener(
            'keydown',
            (event) => {
                if (!shouldTriggerShortcut(event, doc)) {
                    return
                }
                event.preventDefault()
                event.stopImmediatePropagation()
                void switchToNext()
            },
            true,
        )
    }

    const withBaseUrl = (html) => {
        const baseTag = '<base href="https://www.bilibili.com/">'
        if (/<head[^>]*>/i.test(html)) {
            return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
        }
        return `${baseTag}${html}`
    }

    const countCards = (doc) => {
        return doc.querySelectorAll(
            '.container > .feed-card, .container > .bili-video-card, .container > .bili-feed-card',
        ).length
    }

    const isRenderedCard = (card) => {
        if (card.querySelector('.skeleton, .skeleton-item, .loading_animation')) {
            return false
        }
        if (card.textContent.trim().length === 0) {
            return false
        }
        const images = [...card.querySelectorAll('img')]
        return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0)
    }

    const countRenderedCards = (doc) => {
        return [
            ...doc.querySelectorAll(
                '.container > .feed-card, .container > .bili-video-card, .container > .bili-feed-card',
            ),
        ].filter(isRenderedCard).length
    }

    const ensureButtonStyle = (doc) => {
        if (!doc?.documentElement || !doc.head || doc.getElementById(STYLE_ID)) {
            return
        }
        const style = doc.createElement('style')
        style.id = STYLE_ID
        style.textContent = `
            html[${STATE_ATTRIBUTE}='ready'] .feed-roll-btn {
                background: #e8f9ff !important;
                box-shadow: 0 0 0 2px #00aeec, 0 0 14px rgba(0, 174, 236, .5) !important;
                border-radius: 8px !important;
            }
            html[${STATE_ATTRIBUTE}='ready'] .feed-roll-btn button,
            html[${STATE_ATTRIBUTE}='ready'] .feed-roll-btn .roll-btn,
            html[${STATE_ATTRIBUTE}='ready'] .roll-btn {
                background: #00aeec !important;
                color: #fff !important;
                border-color: #00aeec !important;
            }
            html[${STATE_ATTRIBUTE}='loading'] .feed-roll-btn,
            html[${STATE_ATTRIBUTE}='loading'] .roll-btn {
                opacity: .62 !important;
                cursor: progress !important;
            }
            html[${STATE_ATTRIBUTE}='error'] .feed-roll-btn,
            html[${STATE_ATTRIBUTE}='error'] .roll-btn {
                background: #fff1f0 !important;
                box-shadow: 0 0 0 2px #f56c6c !important;
                color: #d93025 !important;
            }
        `
        doc.head.append(style)
    }

    const ensureShellStyle = () => {
        if (document.getElementById(`${STYLE_ID}-shell`) || !document.head) {
            return
        }
        const style = document.createElement('style')
        style.id = `${STYLE_ID}-shell`
        style.textContent = `
            iframe.${FRAME_CLASS} {
                position: fixed;
                top: 0;
                width: 100vw;
                height: 100vh;
                border: 0;
                background: #fff;
            }
            html[${MODE_ATTRIBUTE}] body > :not(iframe.${FRAME_CLASS}):not(#${BUSY_ID}) {
                visibility: hidden !important;
            }
            #${BUSY_ID} {
                position: fixed;
                top: 24px;
                left: 50%;
                z-index: 2147483647;
                transform: translateX(-50%);
                padding: 10px 18px;
                border-radius: 999px;
                color: #fff;
                background: rgba(0, 0, 0, .8);
                font: 14px/1.4 sans-serif;
                pointer-events: none;
            }
        `
        document.head.append(style)
    }

    const showToast = (text, persistent = false) => {
        let toast = document.getElementById(BUSY_ID)
        if (!toast) {
            toast = document.createElement('div')
            toast.id = BUSY_ID
            document.body.append(toast)
        }
        toast.textContent = text
        toast.hidden = false
        clearTimeout(toastTimer)
        if (!persistent) {
            toastTimer = setTimeout(() => {
                toast.hidden = true
            }, 1600)
        }
    }

    const hideToast = () => {
        clearTimeout(toastTimer)
        const toast = document.getElementById(BUSY_ID)
        if (toast) {
            toast.hidden = true
        }
    }

    const updateShortcutControls = () => {
        if (shortcutButton) {
            shortcutButton.textContent = capturingShortcut
                ? '请按下新按键…'
                : formatShortcut()
        }
        if (shortcutToggle) {
            shortcutToggle.checked = settings.shortcutEnabled
        }
    }

    const updateSettingsStatus = (state) => {
        if (!statusNode) {
            return
        }
        const labels = {
            ready: '已就绪',
            loading: '预载中',
            error: '预载失败',
        }
        statusNode.textContent = labels[state] || '未启动'
        statusNode.dataset.state = state || ''
    }

    const createSettingsUi = () => {
        if (settingsHost?.isConnected) {
            return
        }

        settingsHost = document.createElement('div')
        settingsHost.id = SETTINGS_HOST_ID
        settingsHost.style.cssText =
            'position:fixed;right:16px;bottom:16px;z-index:2147483647;font-family:system-ui,sans-serif;'
        const root = settingsHost.attachShadow({ mode: 'open' })
        root.innerHTML = `
            <style>
                :host { all: initial; }
                button, input { font: inherit; }
                #toggle {
                    width: 42px; height: 42px; margin-left: auto; display: block;
                    border: 0; border-radius: 50%; color: #fff; background: #00aeec;
                    box-shadow: 0 4px 16px rgba(0,0,0,.24); cursor: pointer; font-size: 20px;
                }
                #panel {
                    position: absolute; right: 0; bottom: 52px; width: 242px;
                    padding: 14px; border: 1px solid #d9e5ec; border-radius: 12px;
                    background: #fff; color: #222; box-shadow: 0 10px 32px rgba(0,0,0,.2);
                }
                #panel[hidden] { display: none; }
                header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
                header strong { font-size: 15px; }
                #close { border: 0; background: transparent; font-size: 20px; cursor: pointer; color: #666; }
                .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 0; }
                #shortcut { min-width: 72px; padding: 6px 10px; border: 1px solid #b9d9e8; border-radius: 7px; background: #f3fbff; color: #087da8; cursor: pointer; }
                #reset { width: 100%; margin-top: 8px; padding: 7px; border: 1px solid #d5dde3; border-radius: 7px; background: #f7f8fa; cursor: pointer; }
                #status { margin: 10px 0 0; padding-top: 10px; border-top: 1px solid #edf1f4; color: #777; font-size: 12px; }
                #status[data-state='ready'] { color: #078bb5; }
                #status[data-state='error'] { color: #d93025; }
                input[type='checkbox'] { width: 17px; height: 17px; accent-color: #00aeec; }
            </style>
            <button id="toggle" type="button" title="B站预刷新设置" aria-label="打开 B站预刷新设置">⚙</button>
            <section id="panel" hidden>
                <header>
                    <strong>B站预刷新</strong>
                    <button id="close" type="button" aria-label="关闭设置">×</button>
                </header>
                <label class="row">
                    <span>启用快捷键</span>
                    <input id="shortcut-enabled" type="checkbox">
                </label>
                <div class="row">
                    <span>切换快捷键</span>
                    <button id="shortcut" type="button"></button>
                </div>
                <button id="reset" type="button">恢复默认（R）</button>
                <p>在非输入状态触发。点击快捷键后，按下新的单键或组合键。</p>
                <div id="status"></div>
            </section>
        `
        document.documentElement.append(settingsHost)

        const panel = root.getElementById('panel')
        const toggle = root.getElementById('toggle')
        const close = root.getElementById('close')
        shortcutButton = root.getElementById('shortcut')
        shortcutToggle = root.getElementById('shortcut-enabled')
        statusNode = root.getElementById('status')
        const reset = root.getElementById('reset')

        toggle.addEventListener('click', () => {
            panel.hidden = !panel.hidden
        })
        close.addEventListener('click', () => {
            panel.hidden = true
            capturingShortcut = false
            updateShortcutControls()
        })
        shortcutToggle.checked = settings.shortcutEnabled
        shortcutToggle.addEventListener('change', () => {
            settings.shortcutEnabled = shortcutToggle.checked
            saveSettings()
            updateShortcutControls()
        })
        shortcutButton.addEventListener('click', (event) => {
            event.stopPropagation()
            capturingShortcut = true
            updateShortcutControls()
            shortcutButton.focus()
        })
        root.addEventListener(
            'keydown',
            (event) => {
                if (!capturingShortcut) {
                    return
                }
                event.preventDefault()
                event.stopImmediatePropagation()
                if (event.key === 'Escape') {
                    capturingShortcut = false
                    updateShortcutControls()
                    return
                }
                if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
                    return
                }

                settings.shortcut = {
                    code: event.code,
                    key: event.key,
                    ctrl: event.ctrlKey,
                    alt: event.altKey,
                    shift: event.shiftKey,
                    meta: event.metaKey,
                }
                capturingShortcut = false
                saveSettings()
                updateShortcutControls()
                showToast(`快捷键已改为 ${formatShortcut()}`)
            },
            true,
        )
        reset.addEventListener('click', () => {
            capturingShortcut = false
            settings.shortcut = { ...defaultShortcut }
            settings.shortcutEnabled = true
            saveSettings()
            updateShortcutControls()
            showToast('已恢复默认快捷键 R')
        })

        updateShortcutControls()
        updateSettingsStatus(document.documentElement.getAttribute(STATE_ATTRIBUTE))
    }

    const setState = (state) => {
        for (const doc of [
            document,
            activeFrame?.contentDocument,
            nextFrame?.contentDocument,
        ]) {
            if (!doc?.documentElement) {
                continue
            }
            ensureButtonStyle(doc)
            doc.documentElement.setAttribute(STATE_ATTRIBUTE, state)
        }
        updateSettingsStatus(state)
    }

    const setFrameVisible = (frame, visible) => {
        frame.style.left = visible ? '0' : '-20000px'
        frame.style.zIndex = visible ? '2147483646' : '-1'
        frame.style.opacity = visible ? '1' : '0'
        frame.style.pointerEvents = visible ? 'auto' : 'none'
        frame.setAttribute('aria-hidden', visible ? 'false' : 'true')
        frame.tabIndex = visible ? 0 : -1
    }

    const syncPageCleanerStyle = (frame) => {
        const doc = frame.contentDocument
        if (!doc?.documentElement || !doc.head) {
            return
        }

        for (const attr of document.documentElement.attributes) {
            if (attr.name !== MODE_ATTRIBUTE && attr.name !== STATE_ATTRIBUTE) {
                doc.documentElement.setAttribute(attr.name, attr.value)
            }
        }

        let styleIndex = 0
        for (const source of document.querySelectorAll('style.bili-cleaner-css')) {
            if (
                doc.querySelector(
                    `[data-bili-feed-preload-copy="${styleIndex}"]`,
                )
            ) {
                styleIndex += 1
                continue
            }
            const clone = source.cloneNode(true)
            clone.setAttribute('data-bili-feed-preload-copy', String(styleIndex))
            doc.head.append(clone)
            styleIndex += 1
        }
        ensureButtonStyle(doc)
    }

    const attachFrameHandlers = (frame) => {
        const doc = frame.contentDocument
        if (!doc || doc.documentElement.dataset.biliFeedPreloadHandlers === '1') {
            return
        }
        doc.documentElement.dataset.biliFeedPreloadHandlers = '1'
        doc.addEventListener(
            'click',
            (event) => {
                if (!isRollTarget(event.target)) {
                    return
                }
                event.preventDefault()
                event.stopImmediatePropagation()
                void switchToNext()
            },
            true,
        )
        bindShortcuts(doc)
    }

    const waitForFrameReady = async (frame, timeoutMs) => {
        const deadline = Date.now() + timeoutMs
        let nextNudgeAt = Date.now() + 500

        while (Date.now() < deadline) {
            const doc = frame.contentDocument
            if (doc) {
                if (countCards(doc) >= 9 && Date.now() >= nextNudgeAt) {
                    frame.contentWindow?.scrollTo(0, doc.documentElement.scrollHeight)
                    frame.contentWindow?.dispatchEvent(new Event('scroll'))
                    nextNudgeAt = Date.now() + 700
                }
                if (
                    countRenderedCards(doc) >= MIN_CARD_COUNT &&
                    doc.readyState === 'complete'
                ) {
                    frame.contentWindow?.scrollTo(0, 0)
                    attachFrameHandlers(frame)
                    syncPageCleanerStyle(frame)
                    return true
                }
            }
            await sleep(READY_POLL_MS)
        }
        return false
    }

    const createPreloadFrame = async () => {
        if (!isHomePage() || nextFrame) {
            return nextFrame
        }

        const frame = document.createElement('iframe')
        frame.className = FRAME_CLASS
        frame.title = 'B站首页预载页面'
        frame.setAttribute('aria-hidden', 'true')
        frame.tabIndex = -1
        setFrameVisible(frame, false)
        frame.addEventListener('load', () => {
            attachFrameHandlers(frame)
            syncPageCleanerStyle(frame)
            ensureButtonStyle(frame.contentDocument)
        })
        nextFrame = frame
        document.body.append(frame)

        const response = await fetch(HOME_URL, {
            cache: 'no-store',
            credentials: 'include',
        })
        if (!response.ok) {
            throw new Error(`首页请求失败：HTTP ${response.status}`)
        }
        frame.srcdoc = withBaseUrl(await response.text())
        return frame
    }

    const prepareNextFrame = () => {
        if (!isHomePage()) {
            return Promise.resolve(false)
        }
        if (preparing) {
            return preparing
        }

        activeReady = false
        setState('loading')
        preparing = (async () => {
            try {
                const frame = await createPreloadFrame()
                if (!frame) {
                    return false
                }
                activeReady = await waitForFrameReady(frame, READY_TIMEOUT_MS)
                if (!activeReady) {
                    frame.remove()
                    if (nextFrame === frame) {
                        nextFrame = null
                    }
                }
                setState(activeReady ? 'ready' : 'error')
                return activeReady
            } catch {
                nextFrame?.remove()
                nextFrame = null
                setState('error')
                return false
            } finally {
                preparing = null
            }
        })()
        return preparing
    }

    const waitForReady = async (timeoutMs) => {
        if (activeReady && nextFrame) {
            return true
        }
        if (!preparing) {
            void prepareNextFrame()
        }

        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            if (activeReady && nextFrame) {
                return true
            }
            await sleep(READY_POLL_MS)
        }
        return false
    }

    const showFrame = (frame) => {
        const previousFrame = activeFrame
        activeFrame = frame
        nextFrame = null
        setFrameVisible(frame, true)
        document.documentElement.setAttribute(MODE_ATTRIBUTE, '')
        attachFrameHandlers(frame)
        syncPageCleanerStyle(frame)
        ensureButtonStyle(frame.contentDocument)
        frame.contentWindow?.focus()
        if (previousFrame && previousFrame !== frame) {
            previousFrame.remove()
        }
    }

    const scheduleRecovery = (message) => {
        if (recoveryScheduled) {
            return
        }
        recoveryScheduled = true
        switching = true
        setState('error')
        showToast(message, true)
        setTimeout(() => location.reload(), 900)
    }

    const switchToNext = async () => {
        if (switching || !isHomePage()) {
            return
        }
        if (Date.now() < cooldownUntil) {
            showToast('下一页正在预载，请稍候…')
            return
        }

        switching = true
        setState('loading')
        showToast('正在准备下一页…', true)
        try {
            const ready = await waitForReady(CLICK_WAIT_MS)
            if (!ready || !nextFrame?.contentDocument) {
                scheduleRecovery('预载尚未完成，正在整页刷新…')
                return
            }

            const frame = nextFrame
            showFrame(frame)
            hideToast()
            cooldownUntil = Date.now() + CLICK_COOLDOWN_MS
            setState('loading')
            void prepareNextFrame()
        } catch {
            scheduleRecovery('预载切换失败，正在整页刷新…')
        } finally {
            if (!recoveryScheduled) {
                switching = false
            }
        }
    }

    window.addEventListener(
        'click',
        (event) => {
            if (!isRollTarget(event.target)) {
                return
            }
            event.preventDefault()
            event.stopImmediatePropagation()
            void switchToNext()
        },
        true,
    )
    bindShortcuts(document)

    const initialize = () => {
        if (!isHomePage()) {
            return
        }
        ensureShellStyle()
        createSettingsUi()
        ensureButtonStyle(document)
        setState('loading')
        void prepareNextFrame()
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true })
    } else {
        initialize()
    }

    window.addEventListener('pageshow', () => {
        if (isHomePage() && !activeReady && !preparing) {
            void prepareNextFrame()
        }
    })
})()
