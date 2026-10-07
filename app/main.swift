import UIKit

final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    let shell = ShellController()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.overrideUserInterfaceStyle = .dark
        let home = HomeController(shell: shell)
        let nav = UINavigationController(rootViewController: home)
        nav.navigationBar.prefersLargeTitles = true
        window.rootViewController = nav
        window.makeKeyAndVisible()
        self.window = window
        shell.nav = nav
        Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            self?.shell.drain()
        }
        return true
    }
}

final class ShellController {
    weak var nav: UINavigationController?
    var names: [String] = UserDefaults.standard.stringArray(forKey: "pygu.apps") ?? ["Settings", "Notes", "Clock"]

    func drain() {
        let inbox = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        let files = (try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? []
        for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            defer { try? FileManager.default.removeItem(at: file) }
            guard let data = try? Data(contentsOf: file),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let cmd = obj["cmd"] as? String else { continue }
            if cmd == "add" {
                let raw = (obj["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let name = String(raw.prefix(24))
                if !name.isEmpty, !names.contains(name) {
                    names.append(name)
                    UserDefaults.standard.set(names, forKey: "pygu.apps")
                    (nav?.viewControllers.first as? HomeController)?.reload()
                }
            } else if cmd == "tap" {
                let x = (obj["x"] as? NSNumber)?.doubleValue ?? 0
                let y = (obj["y"] as? NSNumber)?.doubleValue ?? 0
                press(x: x, y: y)
            }
        }
    }

    func press(x: Double, y: Double) {
        guard let window = nav?.view.window ?? nav?.view else { return }
        let point = CGPoint(x: window.bounds.width * x, y: window.bounds.height * y)
        let hit = window.hitTest(point, with: nil)
        let flash = UIView(frame: CGRect(x: point.x - 22, y: point.y - 22, width: 44, height: 44))
        flash.backgroundColor = UIColor.white.withAlphaComponent(0.42)
        flash.layer.cornerRadius = 22
        flash.isUserInteractionEnabled = false
        window.addSubview(flash)
        UIView.animate(withDuration: 0.28, animations: { flash.alpha = 0 }) { _ in
            flash.removeFromSuperview()
        }
        guard let hit else { return }
        var node: UIView? = hit
        while let current = node {
            if let toggle = current as? UISwitch {
                toggle.setOn(!toggle.isOn, animated: true)
                toggle.sendActions(for: .valueChanged)
                return
            }
            if let control = current as? UIControl {
                control.sendActions(for: .touchUpInside)
                return
            }
            if let cell = current as? UITableViewCell {
                var parent: UIView? = cell.superview
                while let view = parent {
                    if let table = view as? UITableView, let path = table.indexPath(for: cell) {
                        table.delegate?.tableView?(table, didSelectRowAt: path)
                        return
                    }
                    parent = view.superview
                }
            }
            node = current.superview
        }
    }
}

final class IconControl: UIControl {
    private let plate = UIView()
    private let glyph = UILabel()
    private let caption = UILabel()

    init(name: String) {
        super.init(frame: .zero)
        plate.isUserInteractionEnabled = false
        glyph.isUserInteractionEnabled = false
        caption.isUserInteractionEnabled = false
        plate.layer.cornerRadius = 14
        plate.backgroundColor = IconControl.color(for: name)
        glyph.text = String(name.prefix(1)).uppercased()
        glyph.textAlignment = .center
        glyph.textColor = .white
        glyph.font = .systemFont(ofSize: 26, weight: .semibold)
        caption.text = name
        caption.textAlignment = .center
        caption.textColor = .white
        caption.font = .systemFont(ofSize: 11, weight: .medium)
        caption.adjustsFontSizeToFitWidth = true
        addSubview(plate)
        plate.addSubview(glyph)
        addSubview(caption)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side: CGFloat = 60
        plate.frame = CGRect(x: (bounds.width - side) / 2, y: 0, width: side, height: side)
        glyph.frame = plate.bounds
        caption.frame = CGRect(x: 2, y: 64, width: bounds.width - 4, height: 16)
    }

    static func color(for name: String) -> UIColor {
        switch name {
        case "Settings":
            return UIColor(red: 0.47, green: 0.49, blue: 0.52, alpha: 1)
        case "Notes":
            return UIColor(red: 0.86, green: 0.72, blue: 0.28, alpha: 1)
        case "Clock":
            return UIColor(white: 0.08, alpha: 1)
        default:
            let palette: [UIColor] = [
                UIColor(red: 0.20, green: 0.48, blue: 0.96, alpha: 1),
                UIColor(red: 0.20, green: 0.62, blue: 0.38, alpha: 1),
                UIColor(red: 0.86, green: 0.36, blue: 0.28, alpha: 1),
                UIColor(red: 0.55, green: 0.34, blue: 0.82, alpha: 1),
                UIColor(red: 0.86, green: 0.48, blue: 0.18, alpha: 1),
            ]
            let index = abs(name.utf8.reduce(0) { ($0 &* 33 &+ Int($1)) }) % palette.count
            return palette[index]
        }
    }
}

final class HomeController: UIViewController {
    let shell: ShellController
    private let dock = UIView()
    private var icons: [IconControl] = []
    private var dockIcons: [IconControl] = []

    init(shell: ShellController) {
        self.shell = shell
        super.init(nibName: nil, bundle: nil)
        title = "Home"
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        let wall = CAGradientLayer()
        wall.name = "wall"
        wall.colors = [
            UIColor(red: 0.18, green: 0.28, blue: 0.48, alpha: 1).cgColor,
            UIColor(red: 0.07, green: 0.09, blue: 0.16, alpha: 1).cgColor,
        ]
        wall.frame = view.bounds
        view.layer.insertSublayer(wall, at: 0)
        dock.backgroundColor = UIColor.white.withAlphaComponent(0.14)
        dock.layer.cornerRadius = 30
        view.addSubview(dock)
        reload()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: animated)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.sublayers?.first { $0.name == "wall" }?.frame = view.bounds
        place()
    }

    func reload() {
        (icons + dockIcons).forEach { $0.removeFromSuperview() }
        icons = shell.names.map { makeIcon($0) }
        icons.forEach { view.addSubview($0) }
        let dockNames = Array(shell.names.prefix(4))
        dockIcons = dockNames.map { makeIcon($0) }
        dockIcons.forEach { dock.addSubview($0) }
        view.bringSubviewToFront(dock)
        place()
    }

    private func makeIcon(_ name: String) -> IconControl {
        let icon = IconControl(name: name)
        icon.addAction(UIAction { [weak self] _ in self?.open(name) }, for: .touchUpInside)
        return icon
    }

    private func place() {
        let width = view.bounds.width
        let safe = view.safeAreaInsets
        let dockHeight: CGFloat = 96
        dock.frame = CGRect(
            x: 14,
            y: view.bounds.height - safe.bottom - dockHeight - 10,
            width: width - 28,
            height: dockHeight
        )
        let columns = 4
        let cell = width / CGFloat(columns)
        for (index, icon) in icons.enumerated() {
            let column = index % columns
            let row = index / columns
            icon.frame = CGRect(
                x: CGFloat(column) * cell,
                y: safe.top + 18 + CGFloat(row) * 98,
                width: cell,
                height: 86
            )
        }
        let slot = dock.bounds.width / CGFloat(max(dockIcons.count, 1))
        for (index, icon) in dockIcons.enumerated() {
            icon.frame = CGRect(x: CGFloat(index) * slot, y: 10, width: slot, height: 82)
        }
    }

    private func open(_ name: String) {
        let page: UIViewController
        switch name {
        case "Settings":
            page = SettingsController()
        case "Notes":
            page = NotesController()
        case "Clock":
            page = ClockController()
        default:
            page = NamedController(name: name)
        }
        navigationController?.setNavigationBarHidden(false, animated: false)
        navigationController?.pushViewController(page, animated: true)
    }
}

final class SettingsController: UITableViewController {
    private let labels = ["Wi-Fi", "Bluetooth", "Cellular"]
    private var flags = [true, true, false]

    init() {
        super.init(style: .insetGrouped)
        title = "Settings"
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
    }

    override func numberOfSections(in tableView: UITableView) -> Int { 2 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == 0 ? labels.count : 1
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .value1, reuseIdentifier: nil)
        if indexPath.section == 0 {
            cell.textLabel?.text = labels[indexPath.row]
            cell.detailTextLabel?.text = flags[indexPath.row] ? "On" : "Off"
            let toggle = UISwitch()
            toggle.isOn = flags[indexPath.row]
            toggle.tag = indexPath.row
            toggle.addTarget(self, action: #selector(flipped(_:)), for: .valueChanged)
            cell.accessoryView = toggle
            cell.selectionStyle = .none
        } else {
            cell.textLabel?.text = "General"
            cell.accessoryType = .disclosureIndicator
        }
        return cell
    }

    @objc private func flipped(_ sender: UISwitch) {
        flags[sender.tag] = sender.isOn
        let path = IndexPath(row: sender.tag, section: 0)
        tableView.cellForRow(at: path)?.detailTextLabel?.text = sender.isOn ? "On" : "Off"
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        if indexPath.section == 1 {
            navigationController?.pushViewController(NamedController(name: "General"), animated: true)
        }
    }
}

final class NotesController: UIViewController, UITextViewDelegate {
    private let textView = UITextView()

    init() {
        super.init(nibName: nil, bundle: nil)
        title = "Notes"
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        textView.font = .systemFont(ofSize: 18)
        textView.backgroundColor = .clear
        textView.text = UserDefaults.standard.string(forKey: "pygu.notes") ?? ""
        textView.delegate = self
        view.addSubview(textView)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        textView.frame = view.bounds.inset(by: view.safeAreaInsets).insetBy(dx: 16, dy: 12)
    }

    func textViewDidChange(_ textView: UITextView) {
        UserDefaults.standard.set(textView.text, forKey: "pygu.notes")
    }
}

final class ClockController: UIViewController {
    private let label = UILabel()
    private var timer: Timer?

    init() {
        super.init(nibName: nil, bundle: nil)
        title = "Clock"
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        label.textColor = .white
        label.textAlignment = .center
        label.font = .monospacedDigitSystemFont(ofSize: 64, weight: .medium)
        view.addSubview(label)
        tick()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        timer?.invalidate()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        label.frame = view.bounds
    }

    private func tick() {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        label.text = formatter.string(from: Date())
    }
}

final class NamedController: UITableViewController {
    private let appName: String

    init(name: String) {
        appName = name
        super.init(style: .insetGrouped)
        title = name
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
    }

    override func numberOfSections(in tableView: UITableView) -> Int { 1 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { 1 }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .value1, reuseIdentifier: nil)
        cell.textLabel?.text = "Name"
        cell.detailTextLabel?.text = appName
        cell.selectionStyle = .none
        return cell
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
