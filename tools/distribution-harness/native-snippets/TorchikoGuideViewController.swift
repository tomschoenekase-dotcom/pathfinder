// Reference only. Supply the exact HTTPS app URL and background from Torchiko.
// Compile and device-test this inside the partner app before release.
import UIKit
import WebKit

final class TorchikoGuideViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    private let guideURL: URL
    private let background: UIColor
    private var webView: WKWebView!
    /// Set when the guide URL includes `placeAction`: open your own screen for this public place ID.
    var onPlaceAction: ((String) -> Void)?

    init(guideURL: URL, background: UIColor) {
        precondition(guideURL.scheme == "https")
        self.guideURL = guideURL
        self.background = background
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("Use init(guideURL:background:)") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = background
        let content = WKUserContentController()
        content.add(self, name: "torchiko")
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController = content
        webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Close", style: .plain,
                                                             target: self, action: #selector(closeGuide))
        webView.load(URLRequest(url: guideURL))
    }

    @objc private func closeGuide() { dismiss(animated: true) }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        // WKSecurityOrigin reports 0 for the scheme's default port.
        let originPort = origin.port == 0 ? 443 : origin.port
        guard message.name == "torchiko", message.frameInfo.isMainFrame,
              origin.protocol == guideURL.scheme, origin.host == guideURL.host,
              originPort == (guideURL.port ?? 443) else { return }
        let body: [String: Any]?
        if let text = message.body as? String, let data = text.data(using: .utf8) {
            body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        } else { body = message.body as? [String: Any] }
        guard body?["source"] as? String == "torchiko", body?["v"] as? Int == 1 else { return }
        switch body?["type"] as? String {
        case "close-requested":
            closeGuide()
        case "place-action":
            // Navigation only: never treat a place ID as a purchase or identity signal.
            if let payload = body?["payload"] as? [String: Any],
               let placeId = payload["placeId"] as? String, !placeId.isEmpty {
                onPlaceAction?(placeId)
            }
        default:
            break
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == guideURL.scheme && url.host == guideURL.host && url.port == guideURL.port {
            decisionHandler(.allow); return
        }
        if ["https", "tel", "mailto", "maps"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }

    deinit { webView?.configuration.userContentController.removeScriptMessageHandler(forName: "torchiko") }
}
