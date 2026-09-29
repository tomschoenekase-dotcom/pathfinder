package com.torchiko.distributionshell.androidqa

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var pageHost: FrameLayout
    private lateinit var placeholder: TextView
    private var activeTab = "Ask"
    private var pendingGeoOrigin: String? = null
    private var pendingAudioRequest: PermissionRequest? = null

    private val appUrl = "http://localhost:4175/app/launcher-p7-a5-9cf727d329"
    private val appBackgroundColor = Color.rgb(13, 22, 22)
    private val guideOrigin = "http://localhost:4175"
    private val requestLocation = 21
    private val requestAudio = 22

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = appBackgroundColor
        window.navigationBarColor = Color.BLACK
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(appBackgroundColor)
        }
        pageHost = FrameLayout(this).apply {
            setBackgroundColor(appBackgroundColor)
        }
        placeholder = TextView(this).apply {
            gravity = Gravity.CENTER
            textSize = 22f
            setTextColor(Color.WHITE)
            setBackgroundColor(appBackgroundColor)
            visibility = View.GONE
        }
        webView = createWebView()
        pageHost.addView(webView, FrameLayout.LayoutParams(-1, -1))
        pageHost.addView(placeholder, FrameLayout.LayoutParams(-1, -1))
        root.addView(pageHost, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(createTabs(), LinearLayout.LayoutParams(-1, dp(64)))
        setContentView(root)

        webView.loadUrl(appUrl)
    }

    private fun createWebView(): WebView = WebView(this).apply {
        setBackgroundColor(appBackgroundColor)
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.setGeolocationEnabled(true)
        settings.mediaPlaybackRequiresUserGesture = true
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val uri = request.url
                if (isGuideOrigin(uri)) return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                } catch (_: Exception) {
                    true
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                val index = pageHost.indexOfChild(view).coerceAtLeast(0)
                pageHost.removeView(view)
                view.destroy()
                val replacement = createWebView()
                replacement.visibility = if (activeTab == "Ask") View.VISIBLE else View.INVISIBLE
                pageHost.addView(replacement, index, FrameLayout.LayoutParams(-1, -1))
                webView = replacement
                replacement.post { if (!isFinishing) replacement.loadUrl(appUrl) }
                return true
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback
            ) {
                if (!isGuideOrigin(Uri.parse(origin))) {
                    callback.invoke(origin, false, false)
                    return
                }
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false)
                } else {
                    pendingGeoOrigin = origin
                    pendingGeoCallback = callback
                    requestPermissions(
                        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                        requestLocation
                    )
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                val audioOnly = request.resources.isNotEmpty() &&
                    request.resources.all { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                if (!isGuideOrigin(Uri.parse(request.origin.toString())) || !audioOnly) {
                    runOnUiThread { request.deny() }
                    return
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    runOnUiThread { request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) }
                } else {
                    pendingAudioRequest = request
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), requestAudio)
                }
            }
        }
    }

    private fun createTabs(): LinearLayout {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.rgb(20, 31, 32))
        }
        listOf("Home", "Tickets", "Map", "Ask").forEach { tab ->
            val button = TextView(this).apply {
                text = tab
                textSize = 14f
                gravity = Gravity.CENTER
                isFocusable = true
                isClickable = true
                contentDescription = "$tab tab"
                setTextColor(Color.WHITE)
                setOnClickListener { selectTab(tab) }
            }
            bar.addView(button, LinearLayout.LayoutParams(0, -1, 1f))
        }
        return bar
    }

    private fun selectTab(tab: String) {
        activeTab = tab
        val showingAsk = tab == "Ask"
        webView.visibility = if (showingAsk) View.VISIBLE else View.INVISIBLE
        placeholder.visibility = if (showingAsk) View.GONE else View.VISIBLE
        placeholder.text = when (tab) {
            "Home" -> "Torchiko\nHome"
            "Tickets" -> "Tickets"
            "Map" -> "Map"
            else -> ""
        }
    }

    private fun isGuideOrigin(uri: Uri): Boolean =
        uri.scheme == "http" && uri.host == "localhost" && uri.port == 4175

    private fun hasLocationPermission(): Boolean =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            requestLocation -> {
                val origin = pendingGeoOrigin ?: return
                val granted = hasLocationPermission()

                pendingGeoOrigin = null
                pendingGeoCallback?.invoke(origin, granted, false)
                pendingGeoCallback = null
            }
            requestAudio -> {
                val request = pendingAudioRequest ?: return
                pendingAudioRequest = null
                val granted = grantResults.isNotEmpty() &&
                    grantResults.all { it == PackageManager.PERMISSION_GRANTED }
                if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                else request.deny()
            }
        }
    }

    private var pendingGeoCallback: GeolocationPermissions.Callback? = null

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
