import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbandoned, isOurBrowser, killOrphanBrowsers, sessionProfileDir } from '../src/orphans';

/** Katalog profilu tak, jak widać go w linii poleceń Chrome na serwerze. */
const PROFIL = '/home/wojciech/whatsapp_loger/.wwebjs_auth/session';
const CHROME = '/root/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome';

test('katalog profilu leży tam, gdzie zakłada go whatsapp-web.js', () => {
    const oczekiwany = sessionProfileDir('/home/wojciech/whatsapp_loger');

    assert.ok(isOurBrowser([CHROME, `--user-data-dir=${PROFIL}`], oczekiwany));
});

test('przeglądarka z naszym profilem zostaje rozpoznana razem z procesami pomocniczymi', () => {
    const profil = sessionProfileDir('/home/wojciech/whatsapp_loger');

    // Sama przeglądarka.
    assert.ok(isOurBrowser([CHROME, '--headless=new', `--user-data-dir=${PROFIL}`], profil));
    // Renderer i proces GPU też dostają ten argument - i one też mają odejść.
    assert.ok(isOurBrowser([CHROME, '--type=renderer', `--user-data-dir=${PROFIL}`], profil));
    assert.ok(isOurBrowser([CHROME, '--type=gpu-process', `--user-data-dir=${PROFIL}`], profil));
    // Chromium z systemu i pakiet Google'a wyglądają inaczej, ale to nadal
    // ta sama rodzina - a CHROME_PATH może wskazywać na każde z nich.
    assert.ok(isOurBrowser(['/usr/bin/chromium', `--user-data-dir=${PROFIL}`], profil));
    assert.ok(isOurBrowser(['/usr/bin/google-chrome', `--user-data-dir=${PROFIL}`], profil));
});

test('cudzy Chrome i procesy bez naszego profilu zostają w spokoju', () => {
    const profil = sessionProfileDir('/home/wojciech/whatsapp_loger');

    // Przeglądarka kogoś innego na tej samej maszynie.
    assert.equal(isOurBrowser([CHROME, '--user-data-dir=/home/ktos/.config/chrome'], profil), false);
    // Nasz katalog, ale to nie jest przeglądarka - choćby czyjś grep w konsoli.
    assert.equal(isOurBrowser(['/usr/bin/grep', `--user-data-dir=${PROFIL}`], profil), false);
    assert.equal(isOurBrowser(['/usr/bin/node', 'dist/index.js', `--user-data-dir=${PROFIL}`], profil), false);
    // Crashpad nie dostaje --user-data-dir i ginie razem z przeglądarką.
    assert.equal(
        isOurBrowser([
            '/root/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome_crashpad_handler',
            '--monitor-self',
            '--database=/root/.config/google-chrome-for-testing/Crash Reports',
        ], profil),
        false,
    );
    // Sam katalog bez argumentu to za mało.
    assert.equal(isOurBrowser([CHROME, '--headless=new'], profil), false);
});

test('profil zapisany inaczej, ale wskazujący to samo miejsce, nadal pasuje', () => {
    const profil = sessionProfileDir('/home/wojciech/whatsapp_loger');

    assert.ok(isOurBrowser([CHROME, `--user-data-dir=${PROFIL}/`], profil));
    assert.ok(
        isOurBrowser(
            [CHROME, '--user-data-dir=/home/wojciech/whatsapp_loger/panel/../.wwebjs_auth/session'],
            profil,
        ),
    );
});

test('przegląd procesów nie rusza niczego, gdy profil do nikogo nie pasuje', () => {
    // Katalog, którego na pewno nikt nie trzyma - lista zabitych ma być pusta.
    assert.deepEqual(killOrphanBrowsers(sessionProfileDir('/nie/ma/takiego/katalogu')), []);
});

test('przeglądarka pracującego loggera nie jest sierotą', () => {
    const zywy = (pid: number): boolean => pid === 4242;

    // Logger 4242 pracuje, jego przeglądarka zostaje w spokoju.
    assert.equal(isAbandoned({ ppid: 4242, pgid: 5000 }, [], zywy), false);
    // Rodzic PID 1 to podręcznikowa sierota.
    assert.ok(isAbandoned({ ppid: 1, pgid: 5000 }, [], zywy));
    // Rodzica już nie ma, choć nie jest to jeszcze PID 1.
    assert.ok(isAbandoned({ ppid: 9999, pgid: 5000 }, [], zywy));
    // Logger zabity przed chwilą - jądro może go jeszcze pokazywać jako żywy.
    assert.ok(isAbandoned({ ppid: 4242, pgid: 5000 }, [4242], zywy));
});
