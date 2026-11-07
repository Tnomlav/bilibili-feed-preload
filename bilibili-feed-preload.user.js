// ==UserScript==
// @name         B站首页换一换预加载（单文件）
// @namespace    https://github.com/Tnomlav/bilibili-feed-preload
// @version      1.1.0
// @description  在隐藏页面中预载可继续加载的 B站首页，点击换一换时快速切换且不增加浏览器标签页。
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

    const shouldTriggerByR = (event, doc) => {
        if (
            event.repeat ||
            event.isComposing ||
            event.keyCode === 229 ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            event.shiftKey
        ) {
            return false
        }

        const isR = event.code === 'KeyR' || event.key?.toLowerCase() === 'r'
        if (!isR) {
            return false
        }

        const path = typeof event.composedPath === 'function' ? event.composedPath() : []
        return ![...path, event.target, doc.activeElement].some(isEditableNode)
    }

    const bindShortcuts = (doc) => {
        doc.addEventListener(
            'keydown',
            (event) => {
                if (!shouldTriggerByR(event, doc)) {
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
