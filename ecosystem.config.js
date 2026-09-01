// Konfiguracja pm2 dla WhatsApp Loggera.
//
// Cały sens tego pliku mieści się w jednej linii: stop_exit_codes. pm2
// domyślnie podnosi proces po KAŻDYM wyjściu, także po takim, które program
// wykonał świadomie. Bez tej listy logger, który wyszedł sam po pokazaniu
// puli kodów QR, wracałby w kółko i sypał kolejnymi kodami - czyli dokładnie
// tym, czemu miał zapobiec.
//
//     npm run build
//     pm2 start ecosystem.config.js
//     pm2 save && pm2 startup
//
// stop_exit_codes wymaga pm2 w wersji 5.1 lub nowszej - sprawdź przez `pm2 -v`.
// Na starszym pm2 ta opcja jest po cichu ignorowana i pętla restartów wraca.

module.exports = {
    apps: [
        {
            name: 'whatsapp-logger',

            // Uruchamiamy launcher, nie sam logger: to on pilnuje panelu,
            // ponawia logger po przejściowych awariach i przekazuje wyżej
            // kod wyjścia, na którym opiera się cała poniższa lista.
            script: 'dist/scripts/uruchom.js',
            cwd: __dirname,

            // Kody, po których pm2 ma zostawić program w spokoju:
            //   0  - zwykłe zatrzymanie,
            //   20 - utrata autoryzacji, potrzebne nowe parowanie,
            //   21 - nikt nie zeskanował kodu QR.
            // Każdy z nich wymaga człowieka, więc restart niczego nie naprawi.
            stop_exit_codes: [0, 20, 21],

            // Awarie przejściowe (kod 2) launcher ponawia sam. Gdyby padł on
            // sam z siebie, pm2 podnosi go z rosnącym odstępem.
            autorestart: true,
            exp_backoff_restart_delay: 5000,

            // pm2 wysyła SIGINT, a launcher czeka do 20 sekund, aż logger
            // dopisze do archiwum to, co ma w pamięci. Krótszy czas na
            // zamknięcie ucinałby ten zapis w połowie.
            kill_timeout: 30000,

            // Jedna instancja i żadnego trybu klastra - w środku siedzi
            // przeglądarka i sesja WhatsApp Web przypisana do tego procesu.
            instances: 1,
            exec_mode: 'fork',

            // Bez tego log pm2 nie ma znaczników czasu i nie da się później
            // powiedzieć, kiedy program się zatrzymał.
            time: true,
            merge_logs: true,
        },
    ],
};
