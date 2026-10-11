/* ============================================================================
 * Surgeon Kernel PA 0.3 — core/os_core.js
 * Ядро машины: водопад логов, сводка с зелёным баннером WELCOME TO SURGEON
 * KERNEL и последовательный shell root@Surgeon_OS:~#.
 *
 * Приглашение — обычная строка ленты, а не панель внизу: Enter фиксирует её,
 * ниже идёт вывод команды, ещё ниже рождается следующее приглашение — сверху
 * вниз, как в настоящем Linux/DOS.
 *
 * Фазы: 1) водопад и 6-7 чисток буфера; 2) сводка (экран чистится ПОЛНОСТЬЮ,
 * баннер, /dev/sda1); 3) shell из 12 команд. Настройки ядро не решает само —
 * читает NVRAM BIOS/GRUB. При перегреве каждую пятую строку идёт красный MCE.
 * shutdown — ACPI S5: монитор гаснет, ввод мёртв до перезагрузки страницы.
 *
 * API: init / destroy / run / stats / rings / writeln / setRing / powerOff
 * ========================================================================== */
(function (window, document) {
    'use strict';

    /* --- 1. Константы ------------------------------------------------------ */
    var PA_VERSION      = 'PA 0.3';
    var PA_SEMVER       = 'v0.3-PA (Pre-Alpha)';
    var BUILD_STAMP     = '2026-10-11 / TPABKA-Core-v7';
    var PROMPT          = 'root@Surgeon_OS:~# ';
    var CARET           = '█';                       // каретка в конце строки ввода
    var HALT_TEXT       = 'System halted. Power down. Please refresh the page to reboot.';
    var RESET_TEXT      = '[ RESET ] Surgeon OS — POST restarting, hold on...';
    var EVENT_NAME      = 'boot_complete';
    var READY_EVENT     = 'kernel_ready';
    var TERMINAL_ID     = 'surgeon-terminal';
    var GRUB_ID         = 'surgeon-grub';
    var DESKTOP_ID      = 'surgeon-desktop';
    var MONITOR_ID      = 'surgeon-monitor';

    /* Ключи NVRAM: те же, что пишет Click BIOS и читает POST. */
    var OC_KEY          = 'surgeon_bios_oc';
    var MEMORY_KEY      = 'surgeon_bios_memory';
    var SATA_KEY        = 'surgeon_bios_storage';
    var USB_KEY         = 'surgeon_bios_usb';
    var SECURE_KEY      = 'surgeon_bios_security';
    var OVERHEAT_KEY    = 'surgeon_bios_overheat';
    var COOLING_KEY     = 'surgeon_driver_pack';
    var DISK_KEY        = 'surgeon_virtual_disk';
    var BOOT_ORDER_KEY  = 'surgeon_boot_order';
    var DISTRO_KEY      = 'surgeon_installed_distros';

    var NVRAM_KEYS = [
        BOOT_ORDER_KEY, OC_KEY, MEMORY_KEY, SATA_KEY, USB_KEY, SECURE_KEY,
        OVERHEAT_KEY, COOLING_KEY, DISK_KEY, DISTRO_KEY
    ];

    /* Красная зона разгона: за 1.35V железо без охлаждения не держится. */
    var OVERHEAT_VOLTAGE = 1.35;
    var MCE_EVERY        = 5;      // каждая пятая строка водопада — аварийная

    /* Водопад: наследие SATA-контроллера из BIOS. */
    var TICK_AHCI       = 10;
    var TICK_IDE        = 60;
    var TICK_MIN        = 4;
    var BUFFER_MIN      = 12;
    var BUFFER_MAX      = 60;
    var BUFFER_FALLBACK = 50;      // экран не измерился — берём паспорт
    var FLUSH_MIN       = 6;
    var FLUSH_MAX       = 7;
    var FLUSH_MARKER    = '--- MEMORY BUFFER FLUSHED ---';

    var BASE_CLOCK      = 3600;
    var BASE_RATIO      = 36;
    var BASE_VOLTAGE    = 1.032;
    var BASE_MEM_MHZ    = 3200;

    /* Паспорт платы: те же строки, что печатает POST. */
    var CPU_MODEL       = 'GenuineSurgeon(R) Virtual Core Processor';
    var BOARD_NAME      = 'Surgeon Z990 (VDFS Bridge)';

    var CORE_MODE       = { NORMAL: 'normal', SAFE: 'safe', RECOVERY: 'recovery' };
    var KEY_ENTER       = 13;
    var KEY_ESCAPE      = 27;
    var KEY_BACKSPACE   = 8;

    var BANNER = [
        '===========================================',
        '            W E L C O M E   T O',
        '          S U R G E O N   K E R N E L',
        '              ' + PA_SEMVER,
        '==========================================='
    ];

    var COMMAND_ORDER = [
        'help', 'clear', 'uname', 'cpuinfo', 'dmesg', 'uptime',
        'whoami', 'version', 'date', 'echo', 'reboot', 'shutdown'
    ];
    /* --- 2. Кольца защиты: старт всегда в Ring 0 --------------------------- */
    var RING_ACCESS = {
        R0: ['*'],
        R1: ['video', 'storage_pww13', 'acpi'],
        R2: ['mouse', 'keyboard', 'net_stack'],
        R3: ['storage_vdfs', 'apps']
    };

    window.SURGEON_CPU_RINGS = {
        RING_0: { name: 'Kernel Mode',      active: true,  access: RING_ACCESS.R0 },
        RING_1: { name: 'Kernel Drivers',   active: false, access: RING_ACCESS.R1 },
        RING_2: { name: 'User Drivers',     active: false, access: RING_ACCESS.R2 },
        RING_3: { name: 'User Mode (Apps)', active: false, access: RING_ACCESS.R3 }
    };
    window.CURRENT_CPU_RING = 0;

    /* --- 3. Состояние модуля ---------------------------------------------- */
    var state = {
        running:     false,
        booted:      false,
        phase:       'idle',       // idle | logs | summary | shell | off | recovery
        config:      null,
        container:   null,
        logEl:       null,
        inputRow:    null,
        inputEl:     null,
        input:       '',
        token:       0,            // счётчик прогонов: старые циклы замолкают
        tickMs:      TICK_AHCI,
        baseTickMs:  TICK_AHCI,
        speed:       1,
        ioThrottle:  1,
        capacity:    BUFFER_FALLBACK,
        bufferLines: 0,
        flushed:     0,            // кругов очистки в текущем водопаде
        flushTotal:  0,            // за всю жизнь страницы
        flushCycles: FLUSH_MIN,
        printed:     0,            // строк водопада в текущем прогоне
        replayed:    0,            // сколько раз играли dmesg
        mceCount:    0,
        mceLines:    [],           // MCE текущего прогона: экран после сводки пуст
        shakeNext:   false,        // срыв каретки переезжает на новое приглашение
        keyHandler:  null,
        lockHandler: null,         // глушилка клавиш после останова машины
        offEl:       null,
        inputLocked: false         // shutdown: ввод мёртв до перезагрузки страницы
    };

    /* --- 4. Мелкие хелперы ------------------------------------------------ */
    function el(tag, className, text) {
        var node = document.createElement(tag);

        if (className) { node.className = className; }
        if (typeof text === 'string') { node.textContent = text; }
        return node;
    }

    function sleep(ms) {
        return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function randomInt(min, max) {
        return min + Math.floor(Math.random() * (max - min + 1));
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function trimText(value) {
        return String(value === null || typeof value === 'undefined' ? '' : value)
            .replace(/^\s+|\s+$/g, '');
    }

    function readJSON(key, fallback) {
        try {
            var raw = window.localStorage.getItem(key);
            if (!raw) { return fallback; }

            var parsed = JSON.parse(raw);
            return parsed === null ? fallback : parsed;
        } catch (error) {
            return fallback;      // приватный режим или мусор в хранилище
        }
    }

    function layer(id) {
        return document.getElementById(id);
    }

    function monitor() {
        return layer(MONITOR_ID) || document.body;
    }

    function hideLayer(id) {
        var node = layer(id);

        if (node) { node.style.display = 'none'; }
    }

    /* Клавиши перехватываем, только пока консоль видима. */
    function consoleOnScreen() {
        var node = layer(TERMINAL_ID);

        return !!(node && node.style.display !== 'none');
    }

    function padLeft(value, size) {
        var text = String(value);

        while (text.length < size) { text = '0' + text; }
        return text;
    }

    function formatVoltage(voltage) {
        return (Math.round(voltage * 1000) / 1000).toFixed(3) + 'V';
    }

    function formatRatio(ratio) {
        return ratio + 'x';
    }

    function formatMHz(mhz) {
        return mhz + 'MHz';
    }

    function clockTime(date) {
        return padLeft(date.getHours(), 2) + ':' + padLeft(date.getMinutes(), 2) +
            ':' + padLeft(date.getSeconds(), 2);
    }

    function dateText(date) {
        return date.getFullYear() + '-' + padLeft(date.getMonth() + 1, 2) + '-' +
            padLeft(date.getDate(), 2);
    }

    function isStale(token) {
        return token !== state.token;
    }
    /* --- 5. Железо и NVRAM: снимки настроек BIOS --------------------------- */
    function storageSnapshot() {
        var raw = readJSON(SATA_KEY, null);
        var ide = !!(raw && raw.sata_mode === 'IDE');

        return {
            sataMode:   ide ? 'IDE' : 'AHCI',
            ioThrottle: ide ? 0.7 : 1,
            vdfsBridge: !(raw && raw.vdfs_bridge === false)
        };
    }

    function usbSnapshot() {
        var raw = readJSON(USB_KEY, null);

        return { legacyUsb: !(raw && raw.legacy_usb === false) };
    }

    function securitySnapshot() {
        var raw = readJSON(SECURE_KEY, null);

        return { secureBoot: !!(raw && raw.secure_boot === true) };
    }

    function ocSnapshot() {
        var raw = readJSON(OC_KEY, null);

        return {
            multiplier: (raw && typeof raw.multiplier === 'number') ? raw.multiplier : BASE_RATIO,
            voltage:    (raw && typeof raw.voltage === 'number') ? raw.voltage : BASE_VOLTAGE
        };
    }

    function memorySnapshot() {
        var raw = readJSON(MEMORY_KEY, null);

        return {
            xmp:     (raw && typeof raw.xmp === 'string') ? raw.xmp : 'Disabled',
            freqMhz: (raw && typeof raw.freq_mhz === 'number') ? raw.freq_mhz : BASE_MEM_MHZ,
            cl:      (raw && typeof raw.cl === 'number') ? raw.cl : 16,
            voltage: (raw && typeof raw.dram_voltage === 'number') ? raw.dram_voltage : 1.2
        };
    }

    /* Журнал перегрева: armed = в Setup нажали Save & Exit. */
    function overheatJournal() {
        var raw = readJSON(OVERHEAT_KEY, null);

        if (!raw || typeof raw !== 'object') {
            return { armed: false, active: false, severity: 1, reason: '' };
        }

        return {
            armed:    raw.armed === true,
            active:   raw.active === true,
            severity: (typeof raw.severity === 'number') ? clamp(raw.severity, 1, 3) : 1,
            reason:   raw.reason || ''
        };
    }

    /* Драйверы охлаждения ставит менеджер драйверов (этап 12). */
    function coolingInstalled() {
        var pack = readJSON(COOLING_KEY, null);
        var list = null;
        var i;

        if (!pack) { return false; }

        if (isArray(pack)) {
            list = pack;
        } else if (typeof pack === 'object') {
            if (pack.cooling === true || pack.thermal === true) { return true; }
            list = pack.installed;
        }

        if (!isArray(list)) { return false; }

        for (i = 0; i < list.length; i++) {
            if (list[i] === 'cooling' || list[i] === 'thermal' || list[i] === 'fan_control') {
                return true;
            }
        }
        return false;
    }
    /* Термозащиту считает Click BIOS: ядро только спрашивает. */
    function overheatStatus() {
        var api     = window.SurgeonOverheat;
        var live;
        var journal;

        if (api && typeof api.state === 'function') {
            live = api.state();
            return {
                active:   live.active === true,
                severity: (typeof live.severity === 'number') ? clamp(live.severity, 1, 3) : 1,
                text:     live.text || ''
            };
        }

        journal = overheatJournal();
        return {
            active:   journal.active === true && !coolingInstalled(),
            severity: journal.severity,
            text:     journal.reason
        };
    }

    /* Часы машины считает POST; своя копия — только на случай тишины. */
    function perfSnapshot() {
        var api = window.SurgeonPerf;
        var oc  = ocSnapshot();
        var mem = memorySnapshot();

        if (api && typeof api.snapshot === 'function') { return api.snapshot(); }

        return {
            ratio:       oc.multiplier,
            voltage:     oc.voltage,
            memoryXmp:   mem.xmp,
            memoryMHz:   mem.freqMhz,
            memoryCL:    mem.cl,
            cpuMHz:      Math.round(BASE_CLOCK * (oc.multiplier / BASE_RATIO)),
            memoryClock: Math.round(mem.freqMhz / 2),
            speed:       1,
            throttled:   false,
            text:        'SurgeonPerf absent — clocks from the spec sheet'
        };
    }

    /* Снимок настроек на прогон: все строки водопада читают одно и то же. */
    var platform = null;

    function readPlatform() {
        var storage  = storageSnapshot();
        var usb      = usbSnapshot();
        var security = securitySnapshot();
        var perf     = perfSnapshot();

        return {
            sataMode:   storage.sataMode,
            ioThrottle: storage.ioThrottle,
            vdfsBridge: storage.vdfsBridge,
            legacyUsb:  usb.legacyUsb,
            secureBoot: security.secureBoot,
            speed:      clamp(perf.speed || 1, 0.4, 1.8),
            perf:       perf
        };
    }

    function ensurePlatform() {
        if (!platform) { platform = readPlatform(); }
        return platform;
    }

    /* Интервал строки: IDE тянет до 60 мс, AHCI держит 10, разгон ускоряет. */
    function logTickMs() {
        var snap = ensurePlatform();
        var base = (snap.sataMode === 'IDE') ? TICK_IDE : TICK_AHCI;

        return Math.max(TICK_MIN, Math.round((base * logScale) / snap.speed));
    }

    /* --- 5a. Диск и виртуальный /sys/boot.config --------------------------- */
    function diskInfo() {
        var scan = readJSON(DISK_KEY, null);
        var disk = (scan && scan.disk) ? scan.disk : null;
        var reg  = window.TPABKA_REGISTRY;
        var hw   = (reg && reg.hardware && reg.hardware.storage) ? reg.hardware.storage : null;

        if (disk) {
            return {
                label:      disk.label || 'SURGEON_VDFS_SSD',
                sizeMb:     disk.size_mb || 0,
                partitions: isArray(disk.partitions) ? disk.partitions : []
            };
        }
        if (hw) {
            return {
                label:      hw.device || 'SURGEON_VDFS_SSD',
                sizeMb:     0,
                partitions: isArray(hw.partitions) ? hw.partitions : []
            };
        }
        return { label: 'SURGEON_VDFS_SSD', sizeMb: 0, partitions: [] };
    }

    /* Сеть и пакеты поднимут свои модули; пока их нет — честные нули. */
    function virtualConfig() {
        var packs   = readJSON('surgeon_pkg_installed', null);
        var distros = readJSON(DISTRO_KEY, null);
        var list    = isArray(packs) ? packs : null;

        if (!list && packs && typeof packs === 'object' && isArray(packs.installed)) {
            list = packs.installed;
        }

        return {
            videoMode: 'standard_text',
            powerPlan: 'performance',
            net:       window.TPABKA_NET ? 'up' : 'down',
            packages:  list ? list.length : 0,
            distros:   isArray(distros) ? distros.length : 0
        };
    }
    /* --- 6. Водопад логов: 50 строк ядра ----------------------------------- */
    /* Порядок как на живой плате; токены %ИМЯ% подставляет logVars(). */
    var RAM_TOTAL_MB = 4096;

    var LOG_SCRIPT = [
        '[ INFO ] Surgeon Kernel PA 0.3 (x86_64) — TPABKA Engine Core v7',
        '[ OK ] Boot protocol: Multiboot2, loader = Surgeon Boot Manager (GRUB 2.06)',
        '[ OK ] cmdline: core_mode=%MODE% quiet=0 nomodeset=0 tpabka_core=v7',
        '[ OK ] Memory map: RAM %RAM% MB, 0x0000000000010000-0x000000000009FBFF usable',
        '[ INFO ] Reserved: 0x00000000007A0B4B41 TPABKA_MAGIC_SIGNATURE (ancestor image)',
        '[ OK ] GDT: 7 descriptors, CS=0x0008 DS=0x0010, base 0xFFFF800000000000',
        '[ OK ] GDT-segment: TPABKA_MAGIC_SIGNATURE verified at 0x00000000007A0B',
        '[ OK ] IDT: 256 gates installed, ISR stubs @ 0xFFFF8000000A0000',
        '[ OK ] Paging: 4-level, kernel half mapped 2 MB pages, NX enabled',
        '[ OK ] PIC: 8259 legacy masked, IOAPIC @ 0xFEC00000 online',
        '[ OK ] IRQ map: 0=timer 1=keyboard 2=cascade 4=serial 8=RTC 12=PS2 mouse 14=ATA-0',
        '[ OK ] Timer: TSC @ %CLOCK% MHz, HPET fallback off, tick 1000 Hz',
        '[ OK ] ACPI: RSDP 0x000F0000, FADT/PIIT tables valid, power state S0',
        '[ OK ] PCI: bus 0..3 probed, 14 devices enumerated',
        '[ INFO ] PCI 00:1F.2 mass storage controller: %SATA%',
        '[ OK ] ATA link: %LINK%',
        '[ OK ] ATA device 0.0: %DISK% (%SIZE% MB), S.M.A.R.T. OK',
        '[ OK ] Partition table: GPT valid, %PARTS% partitions (pww13 protected)',
        '[ OK ] USB: EHCI controller up, legacy emulation %LEGACY%',
        '[ INFO ] USB device 3-1: HID Keyboard (boot protocol, rev 2.00)',
        '[ INFO ] USB device 4-1: HID Mouse (boot protocol, 1000 Hz polling)',
        '[ OK ] VGA text mode: 80x25, 4-bit attribute matrix, font ROM @ 0xC0000',
        '[ OK ] Console: kernel text console attached, stdin = %STDIN%',
        '[ OK ] ttyS0: 16550A UART @ 0x03F8, 115200 8N1',
        '[ INFO ] VDFS bridge: %BRIDGE%',
        '[ OK ] Block layer: mq-deadline elevator, io_throttle %THROTTLE%',
        '[ OK ] VFS: pww13 mounted ro on /, vdfs mounted rw on /home',
        '[ INFO ] Mount table: /core /drivers /usr /var — 4 virtual mounts',
        '[ OK ] Random: entropy pool 256 bits, source TPABKA_RNG_SEED',
        '[ OK ] Crypto: CRC32/TPABKA-CHKSUM self-test passed in 0.7 ms',
        '[ OK ] Timekeeping: RTC drift 0.00 s/day, century register OK',
        '[ OK ] Scheduler: CFS core v7 online, 4 logical CPUs, idle class ready',
        '[ OK ] RCU: hierarchical tree initialized, grace period 3 ticks',
        '[ OK ] Namespaces: pid, mnt, net, uts mounted',
        '[ OK ] sysfs: /sys mounted, /sys/boot.config linked',
        '[ OK ] procfs: /proc mounted, /proc/cpuinfo exporter ready',
        '[ INFO ] Thermal zone 0: CPU package sensor armed, polling 250 ms',
        '[ OK ] Thermal zone 1: MCH sensor armed, polling 500 ms',
        '[ OK ] Power governor: performance, C-states limited to C1',
        '[ OK ] ASLR: kernel text randomized to 0xFFFF80007A0B0000',
        '[ OK ] Stack canary: 0x7A0B4B41 (TPABKA_MAGIC) loaded',
        '[ OK ] MCE: machine check bank 0 armed, threshold logging on',
        '[ OK ] NVRAM: %NVRAM% records restored from BIOS, checksum 0x4B41',
        '[ OK ] SYSENTER/SYSCALL gates: Ring 3 -> Ring 0 table built',
        '[ OK ] Audit: lockdown = none, /dev/mem = root only',
        '[ OK ] Watchdog: soft-lockup detector armed at 30 s',
        '[ INFO ] Telemetry: subsystem TPABKA-Core-v7 -> /var/log/surgeon.live',
        "[ OK ] Modules: 0 external modules, pure core boot",
        '[ OK ] DRAM: DDR4-%MEM% @ %MEMCLOCK% MHz CL%CL% XMP[%XMP%]',
        "[ OK ] init: kernel thread 'surgeon-core' (pid 1) spawned"
    ];

    /* Пасхалка прародителя живёт в подписи GDT, канарейке и датчике RNG. */
    function fillTokens(text, vars) {
        var keys = ['MODE', 'RAM', 'CLOCK', 'SATA', 'LINK', 'DISK', 'SIZE', 'PARTS',
            'LEGACY', 'STDIN', 'BRIDGE', 'THROTTLE', 'NVRAM', 'MEM', 'MEMCLOCK', 'CL',
            'XMP'];
        var out = text;
        var i;

        for (i = 0; i < keys.length; i++) {
            out = out.split('%' + keys[i] + '%').join(String(vars[keys[i]]));
        }
        return out;
    }

    function logVars() {
        var snap = ensurePlatform();
        var perf = snap.perf;
        var mem  = memorySnapshot();
        var disk = diskInfo();
        var seen = 0;
        var i;

        for (i = 0; i < NVRAM_KEYS.length; i++) {
            if (readJSON(NVRAM_KEYS[i], null) !== null) { seen++; }
        }

        return {
            MODE:     (state.config && state.config.coreMode) || CORE_MODE.NORMAL,
            RAM:      RAM_TOTAL_MB,
            CLOCK:    perf.cpuMHz,
            SATA:     (snap.sataMode === 'IDE') ? 'IDE legacy PIO (rev 03)' : 'SATA AHCI (rev 03)',
            LINK:     (snap.sataMode === 'IDE')
                ? 'IDE PIO mode 4, UDMA off — io_throttle 0.7'
                : 'AHCI link 6.0 Gb/s, 6 ports, irq 14',
            DISK:     disk.label,
            SIZE:     disk.sizeMb,
            PARTS:    disk.partitions.length,
            LEGACY:   snap.legacyUsb ? 'enabled' : 'disabled',
            STDIN:    snap.legacyUsb ? 'PS/2 + USB HID' : 'none (Legacy USB off)',
            BRIDGE:   snap.vdfsBridge
                ? 'virtio queue 0 online, write-back cache'
                : 'disabled by Setup — direct SATA path in use',
            THROTTLE: snap.ioThrottle,
            NVRAM:    seen,
            MEM:      mem.freqMhz,
            MEMCLOCK: perf.memoryClock,
            CL:       mem.cl,
            XMP:      mem.xmp
        };
    }
    /* --- 6a. Подстановки машины: то, что реально выбрали в Setup ----------- */
    function machineLines() {
        var snap    = ensurePlatform();
        var oc      = ocSnapshot();
        var mem     = memorySnapshot();
        var perf    = snap.perf;
        var thermal = overheatStatus();
        var temp    = thermalTemperature();
        var out     = [];

        out.push('[ OK ] CPU: ' + CPU_MODEL + ' @ ' + formatMHz(perf.cpuMHz) + ' (' +
            formatRatio(oc.multiplier) + ' x ' + BASE_CLOCK + ' MHz, ' +
            formatVoltage(oc.voltage) + ')');
        out.push('[ OK ] Board: ' + BOARD_NAME + ' — BIOS ' + PA_VERSION + ', ACPI 6.4');
        out.push('[ OK ] DRAM voltage: ' + formatVoltage(mem.voltage) + ', XMP profile: ' + mem.xmp);

        if (snap.secureBoot) {
            out.push('[ OK ] Secure Boot: enabled, keys in NVRAM (TPABKA signed)');
        } else {
            out.push('[ WARN ] Secure Boot: disabled — unsigned core accepted');
        }

        if (snap.vdfsBridge) {
            out.push('[ OK ] VDFS: bridge bound to /dev/vda, pww13 stack loaded');
        } else {
            out.push('[ WARN ] VDFS: bridge disabled by Setup — direct SATA path in use');
        }

        if (snap.legacyUsb) {
            out.push('[ OK ] HID input: legacy USB enabled, keyboard on irq 1 / usb 3-1');
        } else {
            out.push('[ WARN ] HID input: Legacy USB Support [Disabled] — keyboard not found');
        }

        out.push('[ OK ] Thermal: package ' + temp + 'C, Tjmax 105C, fan curve performance');

        if (thermal.active) {
            out.push('[ ERR ] Thermal zone 0: package trip point crossed, throttling engaged');
            if (thermal.severity > 1) {
                out.push('[ ERR ] Thermal zone 1: MCH above 82C, emergency shutdown armed');
            }
        }
        return out;
    }

    /* Строки колец: активен всегда ровно один уровень привилегий. */
    function ringLines() {
        var rings = window.SURGEON_CPU_RINGS;
        var order = ['RING_0', 'RING_1', 'RING_2', 'RING_3'];
        var out = [];
        var i;
        var ring;

        for (i = 0; i < order.length; i++) {
            ring = rings[order[i]];

            if (ring.active) {
                out.push('[ OK ] CPU ring ' + i + ' online: ' + ring.name + ' — access ' +
                    ring.access.join(', '));
            } else {
                out.push('[ INFO ] CPU ring ' + i + ' standby: ' + ring.name + ' (access ' +
                    ring.access.join(', ') + ')');
            }
        }

        out.push('[ OK ] Ring isolation: IOPL=0, CR4.SMEP/SMAP on, TSS per-CPU loaded');
        out.push('[ OK ] CURRENT_CPU_RING = ' + window.CURRENT_CPU_RING +
            ' — all hardware control stays in Ring 0');
        return out;
    }

    /* Термозащита в логе: либо драйвер охлаждения, либо предупреждение. */
    function coolingLine() {
        var thermal = overheatStatus();

        if (coolingInstalled()) {
            return '[ OK ] Cooling driver: fan_control v2 bound to thermal zone 0';
        }
        if (thermal.active) {
            return '[ WARN ] Cooling driver table: empty — thermal guard without driver';
        }
        return '[ WARN ] Cooling driver: not installed (driver pack: 0 modules)';
    }

    /* Добивает круг, если подстановок не хватило до низа экрана. */
    var STEADY_LOG_POOL = [
        '[ OK ] IRQ 8: RTC update interrupt, drift compensation nominal',
        '[ OK ] APIC: LAPIC timer calibrated, TSC deadline mode',
        '[ OK ] sysfs: /sys/boot.config re-read by init, schema v1',
        '[ INFO ] VDFS: journal replay skipped, clean unmount detected',
        '[ OK ] pww13: partition 1 write-protected by kernel policy',
        '[ OK ] TPABKA-Core-v7: heartbeat 0x4B41, watchdog pet OK',
        '[ OK ] Memory allocator: SLAB + 2 MB hugepages, fragmentation 1%',
        '[ INFO ] PCI 00:1F.3 audio controller parked (driver pack empty)',
        '[ OK ] USB 2-1: flash drive enumerated (VDFS bridge candidate)',
        '[ OK ] PS/2: keyboard controller self-test 0xAA passed',
        '[ OK ] Monitor: 60 Hz refresh, blanking suppressed in console mode',
        '[ OK ] TPABKA subsystem: ring transition table locked to Ring 0'
    ];
    var steadyIndex = 0;

    function nextSteadyLine() {
        var text = STEADY_LOG_POOL[steadyIndex % STEADY_LOG_POOL.length];

        steadyIndex++;
        return text;
    }

    /* Строка MCE — ровно по спецификации. */
    function mceText() {
        var extra = '';

        if (overheatStatus().severity > 1) {
            extra = ' — voltage rail droop detected';
        }
        return '[ WARN ] Machine Check Exception: CPU Temperature Critical (89C)' + extra;
    }
    /* --- 7. Консоль: DOM, лента строк, каретка ----------------------------- */
    /* #surgeon-terminal — слой поверх GRUB и скроллер; внутри .kernel-screen
     * с лентой .kernel-log, живая строка ввода — в конце ленты. */
    function buildConsole() {
        var node = layer(TERMINAL_ID);
        var screen;
        var log;

        if (!node) {
            node = el('div');
            node.id = TERMINAL_ID;
            monitor().appendChild(node);
        }

        node.textContent = '';
        node.style.display = 'flex';

        screen = el('div', 'kernel-screen');
        log    = el('div', 'kernel-log');

        screen.appendChild(log);
        node.appendChild(screen);

        state.container   = node;
        state.logEl       = log;
        state.inputRow    = null;   // приглашения ещё нет: сначала идут логи
        state.inputEl     = null;
        state.input       = '';
        state.bufferLines = 0;
        state.printed     = 0;
        return node;
    }

    /* Высота одной строки: мерим по живой строке, иначе по временной. */
    function lineHeight() {
        var height = 0;
        var probe;

        if (state.logEl && state.logEl.firstChild) {
            height = state.logEl.firstChild.getBoundingClientRect().height;
        }
        if (height >= 1) { return height; }

        if (state.logEl) {
            probe = el('div', 'kernel-line', 'M');
            state.logEl.appendChild(probe);
            height = probe.getBoundingClientRect().height;
            state.logEl.removeChild(probe);
        }
        if (height >= 1) { return height; }

        return (state.container ? state.container.getBoundingClientRect().height : 400) /
            (BUFFER_FALLBACK + 1);
    }

    /* Ёмкость буфера = строк в видимом окне; высота скроллера постоянна. */
    function measureCapacity() {
        var area = state.container ? state.container.clientHeight : 0;

        if (!area || area < 1) {
            state.capacity = BUFFER_FALLBACK;
            return state.capacity;
        }

        state.capacity = clamp(Math.floor(area / lineHeight()), BUFFER_MIN, BUFFER_MAX);
        return state.capacity;
    }

    function appendLine(text, cls) {
        var node;

        if (!state.logEl) { return null; }

        node = el('div', 'kernel-line' + (cls ? ' ' + cls : ''), text);
        state.logEl.appendChild(node);
        state.bufferLines++;
        state.printed++;
        scrollToBottom();
        return node;
    }

    function writeLines(lines) {
        var i;

        for (i = 0; i < lines.length; i++) { appendLine(lines[i]); }
    }

    /* Новая строка уводит экран вниз: scrollTop = scrollHeight. */
    function scrollToBottom() {
        if (state.container) { state.container.scrollTop = state.container.scrollHeight; }
        if (state.logEl)     { state.logEl.scrollTop     = state.logEl.scrollHeight; }
    }

    /* Строка печатается посимвольно, иначе водопад выглядит как вставка. */
    function writeln(text, cls) {
        var node;
        var i;

        if (!state.logEl) { return null; }

        node = el('div', 'kernel-line' + (cls ? ' ' + cls : ''));
        state.logEl.appendChild(node);
        state.bufferLines++;
        state.printed++;

        for (i = 0; i < text.length; i++) {
            node.textContent += text.charAt(i);
        }
        scrollToBottom();
        return node;
    }

    /* Экран пустеет мгновенно; живую строку ввода заново создаст вызвавший. */
    function clearScreen(marker) {
        if (state.logEl) { state.logEl.textContent = ''; }

        state.bufferLines = 0;
        state.inputRow    = null;
        state.inputEl     = null;

        if (marker) { appendLine(FLUSH_MARKER, 'is-flush'); }
    }

    function resetScreen() {
        clearScreen(false);
        state.printed = 0;
        state.flushed = 0;
        state.input   = '';
    }

    /* --- 7a. Приглашение: живая строка потока, каретка в её конце ---------- */
    /* Живёт до Enter: потом застывает в истории, и ниже рождается следующая. */
    function printPrompt() {
        var row;

        if (!state.logEl) { return null; }
        if (state.inputRow) { return state.inputRow; }   // строка уже ждёт ввода

        row = el('div', 'kernel-line kernel-input-row');

        row.appendChild(el('span', 'kernel-prompt', PROMPT));
        state.inputEl = el('span', 'kernel-input-text');
        row.appendChild(state.inputEl);
        row.appendChild(el('span', 'kernel-caret', CARET));

        state.logEl.appendChild(row);
        state.bufferLines++;
        state.inputRow = row;
        renderInput();
        scrollToBottom();

        if (state.shakeNext) {          // срыв каретки переехал на новую строку
            state.shakeNext = false;
            shakePrompt();
        }
        return row;
    }

    /* Enter: набранный текст фиксируется как статичный лог, каретка снимается. */
    function freezePrompt() {
        var row = state.inputRow;
        var caret;

        if (!row) { return appendEcho(state.input); }

        caret = row.querySelector('.kernel-caret');
        if (caret && caret.parentNode) { caret.parentNode.removeChild(caret); }

        row.className  = 'kernel-line kernel-echo';
        state.inputRow = null;
        state.inputEl  = null;
        state.input    = '';
        state.bufferLines++;
        scrollToBottom();
        return row;
    }

    /* Эхо команды, пришедшей не с клавиатуры (SurgeonCore.run / тесты). */
    function appendEcho(text) {
        var node = el('div', 'kernel-line kernel-echo');

        node.appendChild(el('span', 'kernel-prompt', PROMPT));
        node.appendChild(document.createTextNode(text));

        if (state.logEl) {
            state.logEl.appendChild(node);
            state.bufferLines++;
            scrollToBottom();
        }
        return node;
    }

    /* Приглашение возвращается только в shell: во время логов и сводки его нет. */
    function ensurePrompt() {
        if (state.phase !== 'shell') { return null; }
        return printPrompt();
    }

    /* --- 7b. Набранная строка ---------------------------------------------- */
    function renderInput() {
        if (state.inputEl) { state.inputEl.textContent = state.input; }
    }

    function setInput(text) {
        state.input = trimText(text);
        renderInput();
    }

    function resetInput() {
        state.input = '';
        renderInput();
    }

    /* Недопустимая команда: каретка коротко мигает срывом. */
    function shakePrompt() {
        var caret = state.inputRow ? state.inputRow.querySelector('.kernel-caret') : null;

        if (!caret) {
            state.shakeNext = true;      // строка уже застыла: мигнём следующей
            return;
        }

        caret.style.animation = 'none';
        caret.style.opacity   = '0';

        window.setTimeout(function () {
            caret.style.opacity   = '';
            caret.style.animation = '';
        }, 80);
    }
    /* --- 8. Планшет строк водопада ----------------------------------------- */
    /* Пустые вставки отсеиваем, чтобы не ломать ритм. */
    function validLines(list) {
        var out = [];
        var i;

        for (i = 0; i < list.length; i++) {
            if (typeof list[i] === 'string' && list[i].length) { out.push(list[i]); }
        }
        return out;
    }

    /* 50 строк скрипта + подстановки машины, кольца и термозащита.
     * Вставки идут с хвоста к началу, чтобы индексы оставались валидными. */
    function logLines() {
        var vars    = logVars();
        var extra   = machineLines();
        var rings   = ringLines();
        var thermal = validLines(extra.slice(6)).concat([coolingLine()]);
        var out     = [];
        var i;

        for (i = 0; i < LOG_SCRIPT.length; i++) {
            out.push(fillTokens(LOG_SCRIPT[i], vars));
        }

        out.splice.apply(out, [49, 0].concat([extra[2]]));           // DRAM voltage
        out.splice.apply(out, [38, 0].concat(thermal));              // термозоны
        out.splice.apply(out, [24, 0].concat([extra[4]]));           // VDFS bridge
        out.splice.apply(out, [23, 0].concat([extra[3]]));           // Secure Boot
        out.splice.apply(out, [19, 0].concat([extra[5]]));           // HID input
        out.splice.apply(out, [8, 0].concat(rings));                 // кольца защиты
        out.splice.apply(out, [1, 0].concat([extra[0], extra[1]]));  // CPU и плата

        /* Хвост круга: спокойные строки, чтобы круги не выглядели копией. */
        out.push(nextSteadyLine());
        out.push(nextSteadyLine());

        return validLines(out);
    }

    /* Цвет строки по её тегу. */
    function classifyLine(text) {
        if (text.indexOf(FLUSH_MARKER) !== -1) { return 'is-flush'; }
        if (text.indexOf('Machine Check') !== -1) { return 'is-mce'; }
        if (text.indexOf('Critical') !== -1) { return 'is-err'; }
        if (text.indexOf('[ ERR ]') === 0) { return 'is-err'; }
        if (text.indexOf('[ WARN ]') === 0) { return 'is-warn'; }
        if (text.indexOf('[ INFO ]') === 0) { return 'is-info'; }
        if (text.indexOf('[ BOOT ]') === 0) { return 'is-boot'; }
        if (text.indexOf('[ OK ]') === 0) { return 'is-ok'; }
        return '';
    }

    /* Диск молотит: строки опроса и монтирования накручивают io_throttle. */
    function isDiskLine(text) {
        return text.indexOf('ATA ') !== -1 || text.indexOf('Block layer') !== -1 ||
            text.indexOf('VFS:') !== -1 || text.indexOf('Partition table') !== -1;
    }

    /* Задержка строки: SATA-режим + io_throttle + разгон + длина hex-дампа. */
    function lineDelay(text) {
        var snap  = ensurePlatform();
        var delay = logTickMs();

        if (isDiskLine(text)) {
            delay = Math.round(delay / snap.ioThrottle);
        }
        if (text.length > 90) {
            delay = Math.round(delay * 1.8);
        }
        state.tickMs = delay;
        return delay;
    }
    /* --- 9. Загрузка: водопад, очистка буфера, init / destroy -------------- */
    /* Тормоз safe-режима и разгон идут одним множителем. */
    var logScale = 1;
    var mceArmed = false;

    function writeLine(text) {
        writeln(text, classifyLine(text));
    }

    /* Экран заполнен: очистка, строка флаша, пауза. */
    async function flushLogs(token) {
        clearScreen(true);
        state.flushed++;
        state.flushTotal++;

        await sleep(clamp(state.tickMs * 6, 60, 900));

        return !isStale(token);
    }

    /* Строка за строкой, пока лента не упрётся в нижний край буфера. */
    async function waterfall(lines, token) {
        var i;

        for (i = 0; i < lines.length; i++) {
            if (state.flushed < state.flushCycles &&
                    state.bufferLines + 1 >= state.capacity) {
                if (!await flushLogs(token)) { return false; }
            }
            if (isStale(token)) { return false; }

            writeLine(lines[i]);

            /* Перегрев: каждую пятую строку красный MCE. Текст помним —
             * перед баннером лента чистится, проверяют по stats().mceLines. */
            if (mceArmed) {
                state.mceCount = (state.mceCount + 1) % MCE_EVERY;

                if (state.mceCount === 0) {
                    state.mceLines.push(mceText());
                    writeLine(mceText());
                }
            }

            await sleep(lineDelay(lines[i]));
        }
        return !isStale(token);
    }

    /* 6-7 кругов: логи бегут, буфер чистится, после последнего — сводка. */
    async function runKernelLogs(token) {
        var fresh;

        state.printed     = 0;
        state.flushed     = 0;
        state.mceCount    = 0;
        state.mceLines    = [];
        state.flushCycles = randomInt(FLUSH_MIN, FLUSH_MAX);
        mceArmed          = overheatStatus().active;

        clearScreen(false);
        measureCapacity();

        while (!isStale(token) && state.flushed < state.flushCycles) {
            fresh = logLines();

            if (!await waterfall(fresh, token)) { return false; }
        }
        return !isStale(token);
    }

    /* План прогона: safe-mode читает медленнее, GRUB отдаёт свой множитель. */
    function bootPlan(config) {
        var mode = (config && config.coreMode) || CORE_MODE.NORMAL;

        return {
            speed:   (typeof config.speed === 'number') ? config.speed : 1,
            slowLog: (mode === CORE_MODE.SAFE)
        };
    }

    /* init(): скрыть GRUB, поднять консоль, прогнать водопад, отдать shell. */
    async function init(config) {
        var plan;
        var token;

        state.config  = config || window.SurgeonBootConfig ||
            { coreMode: CORE_MODE.NORMAL };
        state.running = true;
        state.booted  = false;
        state.phase   = 'logs';
        state.token  += 1;
        token = state.token;

        platform = null;                       // свежий снимок NVRAM на прогон
        stopInput();

        plan = bootPlan(state.config);
        logScale = (plan.slowLog ? 1.5 : 1) / (plan.speed || 1);

        hideLayer(GRUB_ID);
        hideLayer(DESKTOP_ID);
        buildConsole();

        document.dispatchEvent(new window.CustomEvent('kernel_boot_start', {
            detail: state.config
        }));

        await runKernelLogs(token);
        if (isStale(token)) { return false; }

        await bootSummary(token);
        if (isStale(token)) { return false; }

        startShell(token);
        state.booted  = true;
        state.phase   = 'shell';
        state.running = false;

        document.dispatchEvent(new window.CustomEvent(READY_EVENT, { detail: stats() }));
        console.log('[KERNEL] ' + PA_SEMVER + ' ready, mode = ' + state.config.coreMode);
        return true;
    }

    /* destroy(): глушим циклы, снимаем слой, заглушку и блокировку. */
    function destroy() {
        state.token  += 1;
        state.running = false;
        state.booted  = false;
        state.phase   = 'idle';

        state.inputLocked = false;
        state.shakeNext   = false;
        state.mceLines    = [];

        stopInput();
        unlockKeyboard();
        removeOffScreen();
        hideLayer(TERMINAL_ID);
        return true;
    }
    /* --- 10. Фаза 2: сводка, баннер и статус диска ------------------------- */
    function partLine(part, index) {
        var pieces = ['/dev/sda' + (index + 1) + ':'];
        var mounts = isArray(part.mount_points) ? part.mount_points.join(',') : '';

        pieces.push(part.fs || 'pww13');
        if (part.size_mb) { pieces.push(part.size_mb + ' MB'); }
        if (mounts) { pieces.push('mount ' + mounts); }
        if (part.protected) { pieces.push('protected by pww13'); }
        return '[ INFO ] ' + pieces.join(' ');
    }

    /* Отчёт после последнего круга или после ручного dmesg: экран чистится
     * ПОЛНОСТЬЮ — логов BIOS/GDT под приглашением не остаётся. */
    async function bootSummary(token, replay) {
        var vcfg = virtualConfig();
        var disk = diskInfo();
        var pause = clamp(state.tickMs * 8, 80, 700);
        var i;

        state.phase = 'summary';

        await sleep(pause);
        if (isStale(token)) { return false; }

        clearScreen(false);              // буфер экрана очищен перед баннером
        appendLine('', '');

        writeLine('[ BOOT ] Configuration loaded from /sys/boot.config');
        await sleep(pause);
        writeLines([
            '[ BOOT ]   VIDEO_MODE = ' + vcfg.videoMode,
            '[ BOOT ]   POWER_PLAN = ' + vcfg.powerPlan,
            '[ BOOT ]   NET = ' + vcfg.net,
            '[ BOOT ]   PACKAGES = ' + vcfg.packages + ' installed'
        ]);
        await sleep(pause);
        if (isStale(token)) { return false; }

        appendLine('', '');
        for (i = 0; i < BANNER.length; i++) {
            appendLine(BANNER[i], 'kernel-banner' + ((i === 0 || i === BANNER.length - 1)
                ? ' is-rule' : ''));
            await sleep(clamp(state.tickMs * 5, 60, 420));
        }
        appendLine('', '');
        if (isStale(token)) { return false; }

        /* Ровно та строка, что стоит в спецификации сразу под баннером. */
        if (vcfg.distros > 0) {
            writeLine('[ INFO ] Distribution found on /dev/sda1: ' + vcfg.distros +
                ' entries — installer will take over the machine (stage 16).');
        } else {
            writeLine('No distribution installed on /dev/sda1. Pure kernel console mode.');
        }

        /* Диск: скан VDFS уже прошёл в POST, ядро только докладывает. */
        writeLine('[ OK ] Storage: ' + disk.label +
            (disk.sizeMb ? ' (' + disk.sizeMb + ' MB)' : '') +
            ', GPT valid, vdfs scan clean');

        for (i = 0; i < disk.partitions.length; i++) {
            appendLine(partLine(disk.partitions[i], i));
        }

        writeLine('[ OK ] Kernel rings: Ring ' + window.CURRENT_CPU_RING + ' active — ' +
            ringSummary());
        writeLine('[ OK ] Shell ready: ' + COMMAND_ORDER.length +
            ' kernel commands, type help for the list');

        if (replay) {
            writeLine('[ OK ] dmesg: ring buffer restored, kernel in Ring ' +
                window.CURRENT_CPU_RING);
        }

        appendLine('', '');
        scrollToBottom();

        document.dispatchEvent(new window.CustomEvent('kernel_boot_log_end'));
        return !isStale(token);
    }

    /* Сводка по кольцам: активное кольцо и те, что ждут пробуждения. */
    function ringSummary() {
        var rings = window.SURGEON_CPU_RINGS;
        var order = ['RING_1', 'RING_2', 'RING_3'];
        var names = [];
        var i;

        for (i = 0; i < order.length; i++) {
            if (!rings[order[i]].active) { names.push(rings[order[i]].name); }
        }
        return names.length ? 'standby: ' + names.join(' / ') : 'all rings online';
    }
    /* --- 11. Фаза 3: shell — приглашение, ввод, Enter ---------------------- */
    /* Точка отсчёта uptime: конфиг бутлоадера, иначе момент загрузки модуля. */
    var bootStamp = Date.now();

    /* Shell поднят: приглашение — в конце потока, клавиши — только после него. */
    function startShell(token) {
        stopInput();

        state.input       = '';
        state.inputLocked = false;
        printPrompt();

        state.keyHandler = function (event) { onKeyDown(event, token); };
        document.addEventListener('keydown', state.keyHandler, true);
        return state.keyHandler;
    }

    function stopInput() {
        if (state.keyHandler) {
            document.removeEventListener('keydown', state.keyHandler, true);
            state.keyHandler = null;
        }
    }

    /* Enter, Backspace, печатаемые символы и Ctrl+L (очистка, как в Linux).
     * После останова машины клавиши не доходят даже сюда. */
    function onKeyDown(event, token) {
        if (state.inputLocked) { return; }
        if (isStale(token) || state.phase !== 'shell' || !consoleOnScreen()) { return; }

        if (event.ctrlKey && (event.key === 'l' || event.key === 'L')) {
            event.preventDefault();
            resetScreen();
            ensurePrompt();
            return;
        }
        if (event.ctrlKey || event.altKey || event.metaKey) { return; }

        if (event.key === 'Enter') {
            event.preventDefault();
            submit(state.input, token);
            return;
        }
        if (event.key === 'Backspace') {
            event.preventDefault();
            state.input = state.input.slice(0, -1);
            renderInput();
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            resetInput();
            return;
        }
        if (typeof event.key === 'string' && event.key.length === 1) {
            event.preventDefault();
            state.input += event.key;
            renderInput();
        }
    }

    /* Enter: строка уходит в историю, ниже — вывод и следующее приглашение. */
    async function submit(raw, token) {
        var text = trimText(raw);

        freezePrompt();                      // набранный текст стал логом

        if (!text.length) {                  // пустой Enter — просто перевод строки
            ensurePrompt();
            return;
        }

        await execute(text, token);
        ensurePrompt();
    }

    /* Публичный запуск команды: то же, что набрать её в консоли. */
    async function runCommand(text) {
        var clean = trimText(text);
        var ok;

        if (state.inputLocked || state.phase === 'off') { return false; }
        if (state.phase !== 'shell') { return false; }     // логи или сводка идут

        if (state.inputRow) {
            setInput(clean);                 // текст встаёт в живую строку
            freezePrompt();                  // и застывает в истории терминала
        } else {
            appendEcho(clean);
        }

        if (!clean.length) { ensurePrompt(); return false; }

        ok = await execute(clean, state.token);
        ensurePrompt();
        return ok;
    }

    /* Разбор строки: имя команды + аргументы (echo получает их как есть). */
    function splitCommand(text) {
        var space = text.indexOf(' ');
        var name;

        if (space === -1) { return { name: text.toLowerCase(), args: '', rawArgs: '' }; }

        name = text.slice(0, space).toLowerCase();
        return {
            name:    name,
            args:    trimText(text.slice(space + 1)),
            rawArgs: text.slice(space + 1)
        };
    }

    /* --- 11a. Таблица команд ----------------------------------------------- */
    var COMMANDS = null;

    function commandTable() {
        if (COMMANDS) { return COMMANDS; }

        COMMANDS = {
            help:     { desc: 'show the kernel command list',          run: cmdHelp },
            clear:    { desc: 'clear the screen, keep the prompt',     run: cmdClear },
            uname:    { desc: 'kernel name, release and architecture', run: cmdUname },
            cpuinfo:  { desc: 'CPU: multiplier, voltage, rings',       run: cmdCpuinfo },
            dmesg:    { desc: 'replay the kernel log waterfall',       run: cmdDmesg },
            uptime:   { desc: 'simulator uptime in seconds',           run: cmdUptime },
            whoami:   { desc: 'current user and protection ring',      run: cmdWhoami },
            version:  { desc: 'kernel and subsystem manifest',         run: cmdVersion },
            date:     { desc: 'RTC chip date and time',                run: cmdDate },
            echo:     { desc: 'echo [text] — print the argument',      run: cmdEcho },
            reboot:   { desc: 'reboot the virtual machine',            run: cmdReboot },
            shutdown: { desc: 'power off the machine (ACPI S5)',       run: cmdShutdown }
        };
        return COMMANDS;
    }

    /* Диспетчер: неизвестная команда — отказ и подсказка, без краха shell. */
    async function execute(text, token) {
        var parsed = splitCommand(text);
        var table  = commandTable();
        var entry  = table[parsed.name];

        if (!entry) {
            appendLine('bash: ' + parsed.name +
                ': command not found in the Surgeon PA 0.3 kernel', 'is-err');
            appendLine('Hint: help — the list of ' + COMMAND_ORDER.length +
                ' kernel commands.', 'is-dim');
            shakePrompt();
            return false;
        }

        await entry.run(parsed.args, parsed.rawArgs, token);
        return true;
    }
    /* --- 11b. Команды ядра ------------------------------------------------ */
    /* help — список всех команд с описанием (печатается зелёным). */
    function cmdHelp() {
        var table = commandTable();
        var i;
        var pad;

        appendLine('[ OK ] Surgeon Kernel ' + PA_SEMVER + ' — available commands:', 'is-help');
        appendLine('', '');

        for (i = 0; i < COMMAND_ORDER.length; i++) {
            pad = COMMAND_ORDER[i];
            while (pad.length < 10) { pad += ' '; }
            appendLine('  ' + pad + '— ' + table[COMMAND_ORDER[i]].desc, 'is-help');
        }

        appendLine('', '');
        appendLine('  Ctrl+L clears the screen, same as clear.', 'is-dim');
    }

    /* clear — чистый экран; приглашение вернётся в конец потока. */
    function cmdClear() {
        resetScreen();
        appendLine('', '');
        ensurePrompt();
    }

    /* uname — архитектура и версия ядра. */
    function cmdUname() {
        appendLine('Surgeon Kernel v0.3-PA x86_64 Core');
        appendLine('  build: ' + BUILD_STAMP, 'is-dim');
    }

    /* cpuinfo — виртуальный CPU: множитель, вольтаж и кольца защиты. */
    function cmdCpuinfo() {
        var snap  = ensurePlatform();
        var oc    = ocSnapshot();
        var mem   = memorySnapshot();
        var perf  = snap.perf;
        var rings = window.SURGEON_CPU_RINGS;
        var i;

        appendLine('processor       : 0');
        appendLine('vendor_id       : GenuineSurgeon');
        appendLine('model name      : ' + CPU_MODEL);
        appendLine('cpu MHz         : ' + formatMHz(perf.cpuMHz) +
            (perf.throttled ? ' (throttled by OC)' : ''));
        appendLine('base clock      : ' + formatMHz(BASE_CLOCK));
        appendLine('multiplier      : ' + formatRatio(oc.multiplier));
        appendLine('core voltage    : ' + formatVoltage(oc.voltage));
        appendLine('memory          : DDR4-' + formatMHz(mem.freqMhz) + ' CL' + mem.cl + ' @ ' +
            formatVoltage(mem.voltage) + ', XMP ' + mem.xmp);
        appendLine('cache size      : 32768 KB (TPABKA-Core L2)');
        appendLine('flags           : fpu vme de pse tsc msr pae mce cx8 apic sep tpabka');
        appendLine('thermal         : package ' + thermalTemperature() + 'C, Tjmax 105C');
        appendLine('hypervisor      : Surgeon PA 0.3 Virtual Machine');
        appendLine('boot config     : ' + ((state.config && state.config.coreMode) || 'normal') +
            ', boot device ' + ((state.config && state.config.bootDevice) || 'vdfs:0'));
        appendLine('');

        for (i = 0; i < 4; i++) {
            appendLine('  Ring ' + i + '  ' + rings['RING_' + i].name + ' — ' +
                (rings['RING_' + i].active ? 'ACTIVE' : 'standby') + '  [' +
                rings['RING_' + i].access.join(', ') + ']');
        }
        appendLine('  CURRENT_CPU_RING = ' + window.CURRENT_CPU_RING +
            ' (System Administrator)');
    }

    /* dmesg — повтор Фазы 1: водопад, круги очистки и снова сводка с баннером.
     * Приглашение — только после баннера: ввод сразу после логов BIOS/GDT нельзя. */
    async function cmdDmesg() {
        var token = state.token;

        if (state.running) {
            appendLine('[ WARN ] dmesg: log waterfall already running, please wait.', 'is-warn');
            return false;
        }

        state.running = true;
        state.phase   = 'logs';
        state.replayed++;
        stopInput();

        appendLine('[ OK ] dmesg: kernel ring buffer replay started', 'is-ok');

        platform = null;                     // NVRAM читаем заново, как при загрузке
        await runKernelLogs(token);
        if (isStale(token)) { return false; }

        await bootSummary(token, true);      // очистка экрана, сводка, баннер
        if (isStale(token)) { return false; }

        startShell(token);
        state.phase   = 'shell';
        state.running = false;
        return true;
    }

    /* uptime — время работы симулятора в секундах. */
    function cmdUptime() {
        var seconds = uptimeSeconds();

        appendLine(' ' + clockTime(new Date()) + ' up ' + formatDuration(seconds) + ' (' +
            seconds + ' seconds since the page was loaded)');
        appendLine(' 1 root session, load average: ' + Math.random().toFixed(2) + ', ' +
            Math.random().toFixed(2) + ', ' + Math.random().toFixed(2));
        appendLine(' kernel booted in ' + state.printed + ' log lines, ' +
            state.flushTotal + ' buffer flushes', 'is-dim');
    }

    /* Время с загрузки: конфиг бутлоадера, иначе момент старта модуля. */
    function uptimeSeconds() {
        var started = window.SurgeonBootConfig && window.SurgeonBootConfig.startedAt;
        var mark = (typeof started === 'number' && started > 0) ? started : bootStamp;

        return Math.max(0, Math.floor((Date.now() - mark) / 1000));
    }

    function formatDuration(total) {
        var seconds = Math.floor(total);
        var hours   = Math.floor(seconds / 3600);
        var minutes = Math.floor((seconds % 3600) / 60);
        var out     = [];

        if (hours) { out.push(hours + ' h'); }
        if (minutes) { out.push(minutes + ' min'); }
        out.push((seconds % 60) + ' sec');
        return out.join(' ');
    }

    /* Температура пакета: при взведённой термозащите она в красной зоне. */
    function thermalTemperature() {
        return (overheatStatus().active ? 89 : 41) + randomInt(0, 2);
    }
    /* whoami — статус авторизации и текущее кольцо защиты. */
    function cmdWhoami() {
        appendLine('root (Ring 0 System Administrator)');
        appendLine('  uid=0(root) gid=0(root) groups=0(root),1(kernel)');
        appendLine('  protection: Ring ' + window.CURRENT_CPU_RING + ' — ' +
            window.SURGEON_CPU_RINGS['RING_' + window.CURRENT_CPU_RING].name);
        appendLine('  host: Surgeon_OS, tty: /dev/console, session: 1 of 1 virtual');
    }

    /* version — развёрнутый манифест ядра. */
    function cmdVersion() {
        appendLine('Surgeon Kernel Engine PA 0.3 (Subsystem: TPABKA-Core-v7)');
        appendLine('  build        : ' + BUILD_STAMP);
        appendLine('  arch         : x86_64, VDFS bridge, pww13 protected partitions');
        appendLine('  boot mode    : ' + ((state.config && state.config.coreMode) || 'normal'));
        appendLine('  shell        : Surgeon Shell PA 0.3 — ' + COMMAND_ORDER.length +
            ' kernel commands');
        appendLine('  memory       : ' + RAM_TOTAL_MB + ' MB virtual, DDR4 ' +
            formatMHz(ensurePlatform().perf.memoryMHz));
        appendLine('  rings        : ' + ringSummary());
        appendLine('  magic        : TPABKA_MAGIC_SIGNATURE 0x7A0B4B41');
        appendLine('  dmesg replay : ' + state.replayed + ' runs');
    }

    /* date — дата и время RTC-чипа. */
    function cmdDate() {
        var now = new Date();

        appendLine(clockTime(now) + ' ' + timezoneOffset(now) + ' ' + dateText(now));
        appendLine('  RTC: CMOS 0x70/0x71, century byte 0x32, drift 0.00 s/day', 'is-dim');
    }

    function timezoneOffset(date) {
        var minutes = -date.getTimezoneOffset();
        var sign    = minutes >= 0 ? '+' : '-';
        var abs     = Math.abs(minutes);

        return 'UTC' + sign + padLeft(Math.floor(abs / 60), 2) + ':' + padLeft(abs % 60, 2);
    }

    /* echo — печать аргумента как есть. */
    function cmdEcho(args, rawArgs) {
        appendLine(rawArgs && rawArgs.length ? rawArgs : '');
    }

    /* reboot — сброс машины: страница перезагружается, POST идёт заново.
     * SurgeonSimReboot = true глушит reload в дым-тесте (как в Click BIOS). */
    function cmdReboot() {
        powerOff('[ OK ] reboot: VDFS synced, ACPI reset asserted...', function () {
            document.dispatchEvent(new window.CustomEvent('surgeon_reboot'));

            if (window.SurgeonSimReboot === true) { return; }
            window.location.reload();
        });
    }

    /* shutdown — питание снято (ACPI S5): монитор гаснет, ввод мёртв до F5. */
    function cmdShutdown() {
        powerOff('[ OK ] shutdown: ACPI S5 — file systems unmounted.', null);
    }

    /* Питание: монитор гаснет, поверх ложится заглушка. onFinish — только у reboot. */
    function powerOff(message, onFinish) {
        var halted = (typeof onFinish !== 'function');

        stopInput();
        state.phase       = 'off';
        state.running     = false;
        state.inputLocked = true;

        if (message) { writeLine(message); }

        window.setTimeout(function () {
            /* Монитор гаснет: слой консоли убирается целиком. */
            hideLayer(TERMINAL_ID);
            hideLayer(GRUB_ID);
            hideLayer(DESKTOP_ID);
            monitor().style.backgroundColor = '#000000';

            if (state.container) { state.container.scrollTop = 0; }

            removeOffScreen();
            state.offEl = el('div', 'kernel-off', halted ? HALT_TEXT : RESET_TEXT);
            monitor().appendChild(state.offEl);

            state.inputRow = null;
            state.inputEl  = null;
            state.input    = '';

            if (halted) {
                lockKeyboard();          // клавиатура мертва: только F5 или Ctrl+R
                document.dispatchEvent(new window.CustomEvent('kernel_halted', {
                    detail: stats()
                }));
                return;
            }

            window.setTimeout(onFinish, 900);
        }, halted ? 240 : 700);
    }

    /* Клавиатура мёртва: пропускаем только F5/Ctrl+R — «физический ребут». */
    function lockKeyboard() {
        if (state.lockHandler) { return state.lockHandler; }

        state.lockHandler = function (event) {
            var reload = (event.key === 'F5') ||
                (event.ctrlKey && (event.key === 'r' || event.key === 'R'));

            if (reload) { return; }

            event.preventDefault();
            event.stopPropagation();
        };

        document.addEventListener('keydown', state.lockHandler, true);
        document.addEventListener('keypress', state.lockHandler, true);
        return state.lockHandler;
    }

    function unlockKeyboard() {
        if (!state.lockHandler) { return false; }

        document.removeEventListener('keydown', state.lockHandler, true);
        document.removeEventListener('keypress', state.lockHandler, true);
        state.lockHandler = null;
        return true;
    }

    /* Заглушка питания снимается перед каждым новым прогоном ядра. */
    function removeOffScreen() {
        var stale = document.querySelectorAll('.kernel-off');
        var i;

        for (i = 0; i < stale.length; i++) {
            if (stale[i].parentNode) { stale[i].parentNode.removeChild(stale[i]); }
        }
        state.offEl = null;
    }
    /* --- 12. Служебное состояние и кольца защиты --------------------------- */
    function stats() {
        var snap = ensurePlatform();

        return {
            version:    PA_SEMVER,
            mode:       (state.config && state.config.coreMode) || CORE_MODE.NORMAL,
            phase:      state.phase,
            booted:     state.booted,
            logLines:   state.printed,
            flushCount: state.flushTotal,
            mceCount:   state.mceCount,
            mceLines:   state.mceLines.slice(0, 4),
            sataMode:   snap.sataMode,
            tickMs:     state.tickMs,
            ring:       window.CURRENT_CPU_RING,
            rings:      window.SURGEON_CPU_RINGS,
            flushMarker: FLUSH_MARKER,
            screenLines: state.logEl ? state.logEl.childNodes.length : 0,
            promptLines: document.querySelectorAll('.kernel-input-row').length,
            inputLocked: state.inputLocked,
            halted:     (state.phase === 'off' && state.inputLocked === true),
            uptime:     uptimeSeconds()
        };
    }

    /* Кольцо меняется только осознанно: остальные уровни гасятся. */
    function setRing(level) {
        var rings = window.SURGEON_CPU_RINGS;
        var i;

        if (typeof level !== 'number' || level < 0 || level > 3) { return false; }

        for (i = 0; i < 4; i++) {
            rings['RING_' + i].active = (i === level);
        }
        window.CURRENT_CPU_RING = level;
        return true;
    }

    function rings() {
        return window.SURGEON_CPU_RINGS;
    }

    /* --- 13. Мост с бутлоадером и экспорт в глобальный контекст ------------ */
    /* boot_complete → ветвление: recovery уходит в аварийный модуль. */
    function wire() {
        document.addEventListener(EVENT_NAME, function () {
            var config = window.SurgeonBootConfig || {};
            var mode   = config.coreMode || CORE_MODE.NORMAL;

            if (mode === CORE_MODE.RECOVERY) {
                state.phase = 'recovery';
                hideLayer(TERMINAL_ID);
                hideLayer(DESKTOP_ID);

                if (window.SurgeonRecovery &&
                        typeof window.SurgeonRecovery.init === 'function') {
                    window.SurgeonRecovery.init(config);
                } else {
                    hideLayer(GRUB_ID);
                    buildConsole();
                    appendLine('[ ERR ] SurgeonRecovery missing — core/os_recovery.js', 'is-err');
                }
                return;
            }

            init(config).catch(function (error) {
                console.error('[KERNEL] kernel boot failed:', error);
            });
        });
        return true;
    }

    window.SurgeonCore = {
        version:     PA_VERSION,
        semver:      PA_SEMVER,
        prompt:      PROMPT,
        commands:    COMMAND_ORDER,
        rings:       rings,
        setRing:     setRing,
        stats:       stats,
        init:        init,
        wire:        wire,
        destroy:     destroy,
        run:         runCommand,
        writeln:     writeln,
        writeLines:  writeLines,
        clear:       resetScreen,
        powerOff:    powerOff,
        haltText:    HALT_TEXT,
        caret:       CARET,
        flushCycles: function () { return state.flushCycles; },
        flushMarker: function () { return FLUSH_MARKER; },
        screenText:  function () { return state.logEl ? state.logEl.textContent : ''; },
        promptEl:    function () { return state.inputRow; },
        promptCount: function () {
            return document.querySelectorAll('.kernel-input-row').length;
        },
        inputLocked: function () { return state.inputLocked; },
        booted:      function () { return state.booted; },
        phase:       function () { return state.phase; },
        logScript:   LOG_SCRIPT
    };

    /* Подписка ставится сразу: boot_complete может прийти раньше готовности. */
    wire();

    console.log('[CORE] os_core.js loaded: ' + PA_SEMVER + ' — ' + LOG_SCRIPT.length +
        ' waterfall lines, Ring 0 active');
})(window, document);
