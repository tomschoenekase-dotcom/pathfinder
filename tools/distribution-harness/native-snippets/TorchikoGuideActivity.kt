// Reference only. Replace URL/background from Torchiko's operator readback;
// compile and emulator-test inside the partner app before release.
// Requires androidx.webkit:webkit for origin-scoped WebViewCompat messaging.
package com.example.torchiko

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

class TorchikoGuideActivity : Activity() {
    private val guideUrl = "https://YOUR-TORCHIKO-ORIGIN/app/YOUR-VENUE?header=none"
    private val guideOrigin = Uri.parse(guideUrl)
    private val guideOriginRule = buildString {
        append(guideOrigin.scheme).append("://").append(guideOrigin.host)
        if (guideOrigin.port != -1) append(":").append(guideOrigin.port)
    }
    private val guideBackground = 0xfff2f5f9.toInt() // Replace from operator readback.
    private lateinit var webView: WebView

    private fun sameGuideOrigin(uri: Uri): Boolean =
        uri.scheme == guideOrigin.scheme && uri.host == guideOrigin.host &&
            (if (uri.port == -1) 443 else uri.port) ==
            (if (guideOrigin.port == -1) 443 else guideOrigin.port)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(guideBackground)
        }
        container.addView(Button(this).apply {
            text = "Close"
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(-1, -2))
        webView = WebView(this).apply {
            setBackgroundColor(guideBackground)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = true
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (!request.isForMainFrame) return false
                    val uri = request.url
                    if (sameGuideOrigin(uri)) return false
                    if (uri.scheme in setOf("https", "tel", "mailto", "geo")) {
                        runCatching {
                            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
                        }
                    }
                    return true
                }
            }
            // Inject only into the exact guide origin. A subframe cannot request native close.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(
                    this, "ReactNativeWebView", setOf(guideOriginRule),
                    object : WebViewCompat.WebMessageListener {
                        override fun onPostMessage(
                            view: WebView, message: WebMessageCompat, sourceOrigin: Uri,
                            isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy
                        ) {
                            if (!isMainFrame || !sameGuideOrigin(sourceOrigin)) return
                            val data = message.data ?: return
                            val body = runCatching { JSONObject(data) }.getOrNull() ?: return
                            if (body.optString("source") != "torchiko" || body.optInt("v") != 1) return
                            when (body.optString("type")) {
                                "close-requested" -> finish()
                                // Only sent when the guide URL includes placeAction.
                                "place-action" -> body.optJSONObject("payload")
                                    ?.optString("placeId")?.takeIf { it.isNotEmpty() }
                                    ?.let { openPlace(it) }
                            }
                        }
                    }
                )
            }
            loadUrl(guideUrl)
        }
        container.addView(webView, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(container)
    }

    /** Open your own screen for this public place ID. Navigation only, never a purchase signal. */
    private fun openPlace(placeId: String) {
        // Example: startActivity(Intent(this, AttractionActivity::class.java).putExtra("placeId", placeId))
    }

    override fun onDestroy() { webView.destroy(); super.onDestroy() }
}
