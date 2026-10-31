// SPDX-License-Identifier: CC0-1.0
/**
 * First-party `github-clones` list (ADR-0016: first-party lists are CC0-1.0). Sites that
 * republish Stack Exchange questions or GitHub repositories and issues wholesale, usually
 * machine-translated, with no way to vote, answer or reach the original. Kind `clone`:
 * enforced, it hides them.
 *
 * Evidence: every entry comes with a copied page and the original it copies, taken from the
 * per-domain evidence tables of the community lists in the starter set (ADR-0017):
 * - arosh/ublacklist-stackoverflow-translation, `domain-list.yml` / `evidence.md` (CC0-1.0),
 * - arosh/ublacklist-github-translation, `domain-list.yml` / `evidence.md` (CC0-1.0),
 * both read at their default branch on 2026-10-31. Entries that upstream writes as `*.x` are
 * written `x` here (a host entry already covers its subdomains). Where the site belongs to an
 * ordinary business and only one section republishes (lightrun, intellipaat, edureka, peaku),
 * the entry is narrowed to that path. Subdomain entries already covered by their parent
 * (`www.giters.com`, `www.solveforum.com`) are left out.
 *
 * Contributions: a public URL of a copied page plus the original it copies, under CC0-1.0.
 * Whole platforms that merely host some copied posts do not belong here.
 */
import type { EvidencedEntry } from './evidence.ts'

export const GITHUB_CLONES_ID = 'github-clones'

export const GITHUB_CLONES: readonly EvidencedEntry[] = [
  // Stack Exchange copies (arosh/ublacklist-stackoverflow-translation evidence.md, CC0-1.0)
  {
    match: 'code-examples.net',
    evidence: 'https://code-examples.net/ja/q/246c591',
    original: 'https://stackoverflow.com/questions/38192529/',
  },
  {
    match: 'answer-id.com',
    evidence: 'https://answer-id.com/ja/53238761',
    original: 'https://arduino.stackexchange.com/questions/21605/',
    note: 'upstream note: redirects to `kzen.dev`',
  },
  {
    match: 'de-vraag.com',
    evidence: 'https://de-vraag.com/ja/53238761',
    original: 'https://arduino.stackexchange.com/q/21605',
    note: 'upstream note: redirects to `kzen.dev`',
  },
  {
    match: 'kzen.dev',
    evidence: 'https://kzen.dev/ja/53238761',
    original: 'https://arduino.stackexchange.com/questions/21605/',
  },
  {
    match: 'living-sun.com',
    evidence:
      'https://living-sun.com/ja/mysql/566242-mysql-select-nested-query-very-complicated-mysql-select-nested.html',
    original: 'https://stackoverflow.com/questions/1599464/',
  },
  {
    match: 'qastack.jp',
    evidence: 'https://qastack.jp/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.ru',
    evidence: 'https://qastack.ru/programming/13150343/the-constant-cannot-be-marked-static',
    original: 'https://stackoverflow.com/q/13150343',
  },
  {
    match: 'qastack.it',
    evidence: 'https://qastack.it/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.mx',
    evidence: 'https://qastack.mx/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.com.br',
    evidence: 'https://qastack.com.br/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.info.tr',
    evidence: 'https://qastack.info.tr/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.in.th',
    evidence: 'https://qastack.in.th/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.com.de',
    evidence: 'https://qastack.com.de/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.fr',
    evidence: 'https://qastack.fr/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.cn',
    evidence: 'https://qastack.cn/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.com.ua',
    evidence: 'https://qastack.com.ua/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.co.in',
    evidence: 'https://qastack.co.in/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.kr',
    evidence: 'https://qastack.kr/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.vn',
    evidence: 'https://qastack.vn/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.net.bd',
    evidence: 'https://qastack.net.bd/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qa-stack.pl',
    evidence: 'https://qa-stack.pl/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'qastack.id',
    evidence: 'https://qastack.id/programming/11227809/',
    original: 'https://stackoverflow.com/questions/11227809/',
  },
  {
    match: 'www.coder.work',
    evidence: 'https://www.coder.work/article/3794436',
    original: 'https://stackoverflow.com/questions/13375357/',
  },
  {
    match: 'www.it-swarm-ja.tech',
    evidence: 'https://www.it-swarm-ja.tech/ja/linux/944475555/',
    original: 'https://superuser.com/questions/1347723/',
    note: 'upstream note: redirects to `www.it-mure.jp.net`',
  },
  {
    match: 'www.it-swarm.jp.net',
    evidence:
      'https://www.it-swarm.jp.net/ja/google-chrome/chrome%e3%81%af%e6%8b%a1%e5%bc%b5%e6%a9%9f%e8%83%bd%e3%82%92%e3%81%a9%e3%81%93%e3%81%ab%e4%bf%9d%e5%ad%98%e3%81%97%e3%81%be%e3%81%99%e3%81%8b%ef%bc%9f/1071750676/',
    original: 'https://stackoverflow.com/q/14543896',
    note: 'upstream note: redirects to `www.it-mure.jp.net`',
  },
  {
    match: 'www.it-swarm-ja.com',
    evidence:
      'https://www.it-swarm-ja.com/ja/javascript/vue%E3%81%A7%E5%8B%95%E4%BD%9C%E3%81%97%E3%81%AA%E3%81%84keyup%E3%82%A4%E3%83%99%E3%83%B3%E3%83%88%E3%81%A7%E5%85%A5%E5%8A%9B%E3%81%97%E3%81%A6%E3%81%8F%E3%81%A0%E3%81%95%E3%81%84/835790755/',
    original: 'https://stackoverflow.com/q/46955147',
  },
  {
    match: 'www.web-dev-qa-db-ja.com',
    evidence: 'https://www.web-dev-qa-db-ja.com/ja/go/816661554/',
    original: 'https://stackoverflow.com/q/61900346',
  },
  {
    match: 'www.it-swarm-fr.com',
    evidence:
      'https://www.it-swarm-fr.com/fr/php/comment-installer-lextension-gmp-pour-php-7.2-en-utilisant-mamp-sur-osx/838751599/',
    original: 'https://stackoverflow.com/q/50435455',
  },
  {
    match: 'www.web-dev-qa-db-fr.com',
    evidence:
      'https://www.web-dev-qa-db-fr.com/fr/php/comment-installer-lextension-gmp-pour-php-7.2-en-utilisant-mamp-sur-osx/838751599/',
    original: 'https://stackoverflow.com/q/50435455',
  },
  {
    match: 'codeguides.site',
    evidence: 'https://codeguides.site/questions/ja/950037/same-ajax-called-twice-jquery',
    original: 'https://stackoverflow.com/q/950037',
  },
  {
    match: 'overcoder.net',
    evidence:
      'https://overcoder.net/q/4014591/%D0%BA%D0%B0%D0%BA-%D0%BF%D0%BE%D0%BA%D0%B0%D0%B7%D0%B0%D1%82%D1%8C-%D0%B4%D0%B8%D0%B0%D0%BB%D0%BE%D0%B3-%D0%BF%D1%80%D0%BE%D0%B3%D1%80%D0%B5%D1%81%D1%81%D0%B0-%D0%B2-%D0%B4%D0%B2%D1%83%D1%85-%D0%B4%D0%B5%D0%B9%D1%81%D1%82%D0%B2%D0%B8%D1%8F%D1%85-%D0%BF%D1%80%D0%B8-%D0%BF%D0%B5%D1%80%D0%B5%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%B8%D0%B8-%D1%81-%D0%BE%D0%B4%D0%BD%D0%BE%D0%B3%D0%BE',
    original: 'https://stackoverflow.com/questions/11500794/',
  },
  {
    match: 'coderoad.ru',
    evidence:
      'https://coderoad.ru/927358/%D0%9A%D0%B0%D0%BA-%D0%BE%D1%82%D0%BC%D0%B5%D0%BD%D0%B8%D1%82%D1%8C-%D1%81%D0%B0%D0%BC%D1%8B%D0%B5-%D0%BF%D0%BE%D1%81%D0%BB%D0%B5%D0%B4%D0%BD%D0%B8%D0%B5-%D0%BB%D0%BE%D0%BA%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5-%D0%BA%D0%BE%D0%BC%D0%BC%D0%B8%D1%82%D1%8B-%D0%B2-Git',
    original: 'https://stackoverflow.com/questions/927358/',
  },
  {
    match: 'voidcc.com',
    evidence: 'http://ja.voidcc.com/question/p-glmhmyzr-pk.html',
    original: 'https://stackoverflow.com/questions/48042872/',
  },
  {
    match: 'www.fixes.pub',
    evidence: 'https://www.fixes.pub/program/38000.html',
    original: 'https://stackoverflow.com/q/49289575',
  },
  {
    match: 'isolution.pro',
    evidence: 'https://isolution.pro/q/an13230537/play-sutoa-kara-apuri-no-gokansei-matorikkusu-o-nyushusuru',
    original: 'https://android.stackexchange.com/q/232739',
  },
  {
    match: 'uwenku.com',
    evidence: 'http://ja.uwenku.com/question/p-oafoukjq-gq.html',
    original: 'https://stackoverflow.com/questions/48045748',
  },
  {
    match: 'ubuntubin.com',
    evidence: 'https://ubuntubin.com/ja/q/214411',
    original: 'https://askubuntu.com/questions/940701',
  },
  {
    match: 'softwareuser.asklobster.com',
    evidence:
      'https://ja.softwareuser.asklobster.com/posts/97342/7zip-%E3%82%B3%E3%83%9E%E3%83%B3%E3%83%89%E3%83%A9%E3%82%A4%E3%83%B3-%E3%83%AF%E3%82%A4%E3%83%AB%E3%83%89%E3%82%AB%E3%83%BC%E3%83%89%E3%83%91%E3%82%BF%E3%83%BC%E3%83%B3%E3%81%A7%E3%83%95%E3%82%A9%E3%83%AB%E3%83%80%E3%82%92%E9%99%A4%E5%A4%96%E3%81%97%E3%81%BE%E3%81%99%E3%81%8B/',
    original: 'https://superuser.com/questions/97342/',
  },
  {
    match: 'fmihm.org',
    evidence: 'https://fmihm.org/805196-how-to-read-the-source-RPLVHV',
    original: 'https://stackoverflow.com/questions/22589269/how-to-read-the-source-code-of-jquery',
  },
  {
    match: 'itectec.com',
    evidence: 'https://itectec.com/superuser/user-id-mapping-with-nfs-on-synology-nas/',
    original: 'https://superuser.com/questions/860553/user-id-mapping-with-nfs-on-synology-nas',
    note: 'upstream note: redirects to super-unix.com',
  },
  {
    match: 'super-unix.com',
    evidence: 'https://super-unix.com/superuser/user-id-mapping-with-nfs-on-synology-nas/',
    original: 'https://superuser.com/questions/860553/user-id-mapping-with-nfs-on-synology-nas',
  },
  {
    match: 'stackovergo.com',
    evidence:
      'https://stackovergo.com/ja/q/1063649/does-netbeans-recognize-javascript-prototypal-inheritance',
    original:
      'https://stackoverflow.com/questions/4531523/does-netbeans-recognize-javascript-prototypal-inheritance',
  },
  {
    match: 'narkive.jp',
    evidence: 'https://security.narkive.jp/oBrsVjXh',
    original: 'https://security.stackexchange.com/questions/373/open-source-penetration-test-automation',
  },
  {
    match: 'intellipaat.com/community',
    evidence:
      'https://intellipaat.com/community/32139/in-python-what-is-the-difference-between-random-uniform-and-random-random',
    original: 'https://stackoverflow.com/questions/30030659/',
    note: 'path only: intellipaat.com is a training company; its /community pages republish Stack Overflow',
  },
  {
    match: 'newbedev.com',
    evidence: 'https://newbedev.com/how-to-combine-many-spring-test-annotations-in-a-single-annotation',
    original:
      'https://stackoverflow.com/questions/31098138/how-to-combine-many-spring-test-annotations-in-a-single-annotation',
  },
  {
    match: 'www.codenong.com',
    evidence: 'https://www.codenong.com/8188108/',
    original: 'https://stackoverflow.com/q/8188108',
  },
  {
    match: 'routinepanic.com',
    evidence: 'https://routinepanic.com/questions/how-to-get-the-home-directory-in-python',
    original:
      'https://stackoverflow.com/questions/4028904/what-is-the-correct-cross-platform-way-to-get-the-home-directory-in-python',
  },
  {
    match: 'tousu.in',
    evidence: 'https://qa.tousu.in/qa/?qa=506161/',
    original: 'https://stackoverflow.com/questions/31189754/get-field-names-list-from-case-class',
  },
  {
    match: 'tutorialmore.com',
    evidence: 'https://tutorialmore.com/questions-838617.htm',
    original: 'https://superuser.com/questions/1183564/',
  },
  {
    match: 'wujigu.com',
    evidence: 'https://qa.wujigu.com/qa/?qa=1160352',
    original: 'https://stackoverflow.com/questions/43179984',
  },
  {
    match: 'webdevdesigner.com',
    evidence: 'https://webdevdesigner.com/q/argparse-subparser-monolithic-help-output-137439/',
    original: 'https://stackoverflow.com/questions/20094215/argparse-subparser-monolithic-help-output',
  },
  {
    match: 'developreference.com',
    evidence:
      'https://python.developreference.com/article/13679273/python+argparse+mutually_exclusive_group+and+add_argument_group+in+a+parent+processor%3f',
    original:
      'https://stackoverflow.com/questions/46066374/python-argparse-mutually-exclusive-group-and-add-argument-group-in-a-parent-proc',
  },
  {
    match: 'www.semicolonworld.com',
    evidence: 'https://www.semicolonworld.com/question/57502/python-decompressing-gzip-chunk-by-chunk',
    original: 'https://stackoverflow.com/questions/2423866/python-decompressing-gzip-chunk-by-chunk',
  },
  {
    match: 'qi-u.com',
    evidence: 'https://www.qi-u.com/?qa=580340/python-argparse-subparser-monolithic-help-output',
    original: 'https://stackoverflow.com/questions/20094215/argparse-subparser-monolithic-help-output',
  },
  {
    match: 'stackoom.com',
    evidence: 'https://stackoom.com/en/question/2NpRm',
    original: 'https://stackoverflow.com/questions/35231982/detecting-instance-method-constexpr-with-sfinae',
  },
  {
    match: 'www.generacodice.com',
    evidence: 'https://www.generacodice.com/jp/articolo/119396/C%23+get+thumbnail+from+file+via+windows+api',
    original: 'https://stackoverflow.com/questions/1439719',
  },
  {
    match: 'sqlite.in',
    evidence: 'https://qa.sqlite.in/?qa=159286/',
    original: 'https://stackoverflow.com/questions/5164930',
  },
  {
    match: 'stackguides.com',
    evidence: 'https://stackguides.com/questions/55582335',
    original: 'https://stackoverflow.com/questions/55582335',
  },
  {
    match: 'www.stackfinder.ru',
    evidence: 'https://www.stackfinder.ru/questions/60256300/swaggerui-5-0-0-ignoring-jsonproperty-name',
    original: 'https://stackoverflow.com/questions/60256300',
  },
  {
    match: 'www.desenv-web-rp.com',
    evidence:
      'https://www.desenv-web-rp.com/pt/c%23/como-desativar-ou-manipular-camelcasing-na-resposta-json-do-asp.net-core/826978340/',
    original: 'https://stackoverflow.com/questions/38728200',
    note: 'upstream note: redirects to `www.kutombawewe.net`',
  },
  {
    match: 'www.web-dev-qa-db-pt.com',
    evidence:
      'https://www.web-dev-qa-db-pt.com/pt/c%23/como-desativar-ou-manipular-camelcasing-na-resposta-json-do-asp.net-core/826978340/',
    original: 'https://stackoverflow.com/questions/38728200',
    note: 'upstream note: redirects to `www.kutombawewe.net`',
  },
  {
    match: 'www.kutombawewe.net',
    evidence:
      'https://www.kutombawewe.net/pt/c%23/como-desativar-ou-manipular-camelcasing-na-resposta-json-do-asp.net-core/826978340/',
    original: 'https://stackoverflow.com/questions/38728200',
  },
  {
    match: 'question-it.com',
    evidence:
      'https://question-it.com/questions/12118832/kak-izmenit-kljuch-interfejsa-znachenie-stroka-na-kljuch-stroka-stroka',
    original:
      'https://stackoverflow.com/questions/70786700/how-to-change-the-interface-key-value-string-to-key-string-string',
    note: 'upstream note: mirrors for other languages are specified in the head tag',
  },
  {
    match: 'mediatagtw.com',
    evidence: 'https://programming.mediatagtw.com/article/Textarea+select+all',
    original: 'https://stackoverflow.com/questions/7313786/highlight-all-text-in-textarea',
    note: 'upstream note: other subdomains seem to be clones or machine-generated.',
  },
  {
    match: 'progi.pro',
    evidence: 'https://progi.pro/yavlyaetsya-x86-cmpxchg-atomom-11771983',
    original:
      'https://stackoverflow.com/questions/27837731/is-x86-cmpxchg-atomic-if-so-why-does-it-need-lock',
  },
  {
    match: 'ask-dev.ru',
    evidence:
      'https://ask-dev.ru/info/12969289/jest-how-to-mock-console-when-it-is-used-by-a-third-party-library',
    original:
      'https://stackoverflow.com/questions/41223963/jest-how-to-mock-console-when-it-is-used-by-a-third-party-library',
  },
  {
    match: 'askcodez.com',
    evidence: 'https://askcodez.com/junit-test-des-setters-et-des-getters-de-variables-dinstance.html',
    original:
      'https://stackoverflow.com/questions/21354311/junit-test-of-setters-and-getters-of-instance-variables',
  },
  {
    match: 'iquestion.pro',
    evidence:
      'https://iquestion.pro/q/as13032164/watashitachi-ni-mukerareteinai-parusa-o-kenshutsu-dekimasu-ka',
    original:
      'https://astronomy.stackexchange.com/questions/34366/can-we-detect-pulsars-that-arent-pointed-towards-us',
  },
  {
    match: 'programmierfrage.com',
    evidence: 'https://programmierfrage.com/items/phpmailer-custom-header-set-but-not-shown-on-delivery',
    original:
      'https://stackoverflow.com/questions/65253795/phpmailer-custom-header-set-but-not-shown-on-delivery',
  },
  {
    match: 'microeducate.tech',
    evidence: 'https://microeducate.tech/direct2d-off-screen-rendering-and-hardware-acceleration/',
    original:
      'https://gamedev.stackexchange.com/questions/16446/direct2d-off-screen-rendering-and-hardware-acceleration',
  },
  {
    match: '1r1g.com',
    evidence: 'https://qa.1r1g.com/sf/ask/1154372761/',
    original:
      'https://stackoverflow.com/questions/16491039/maximum-query-length-to-avoid-epipe-error-in-node-js',
  },
  {
    match: 'errorsfixing.com',
    evidence: 'https://errorsfixing.com/python-get-directory-two-levels-up/',
    original: 'https://stackoverflow.com/questions/27844088/python-get-directory-two-levels-up',
  },
  {
    match: 'syntaxfix.com',
    evidence: 'https://syntaxfix.com/question/6689/python-get-directory-two-levels-up',
    original: 'https://stackoverflow.com/questions/27844088/python-get-directory-two-levels-up',
  },
  {
    match: 'codegrepr.com',
    evidence: 'https://codegrepr.com/question/python-get-directory-two-levels-up/',
    original: 'https://stackoverflow.com/questions/27844088/python-get-directory-two-levels-up',
  },
  {
    match: 'cainiaojiaocheng.com',
    evidence:
      'https://cainiaojiaocheng.com/questions/4942471/how-to-rename-files-in-directory-with-its-sha1-hash-with-python',
    original:
      'https://stackoverflow.com/questions/4942471/how-to-rename-files-in-directory-with-its-sha1-hash-with-python',
  },
  {
    match: 'www.linuxfixes.com',
    evidence: 'https://www.linuxfixes.com/2022/02/solved-vs-code-remote-development.html',
    original:
      'https://stackoverflow.com/questions/64369073/vs-code-remote-development-problem-with-ssh-connection-windows-to-linux',
  },
  {
    match: 'www.web-dev-qa.com',
    evidence: 'https://www.web-dev-qa.com/ja/bash/962672142/',
    original: 'https://unix.stackexchange.com/questions/395742/',
    note: 'upstream note: redirects to `www.wake-up-neo.net`',
  },
  {
    match: 'www.wake-up-neo.net',
    evidence:
      'https://www.wake-up-neo.net/ru/javascript/poluchit-epohu-na-opredelennuyu-datu-ispolzuya-javascript/969526135/',
    original: 'https://stackoverflow.com/questions/3367415/get-epoch-for-a-specific-date-using-javascript',
  },
  {
    match: 'flutterhq.com',
    evidence: 'https://flutterhq.com/questions-and-answers/2215/how-to-use-dropdownbutton-with-same-value',
    original: 'https://stackoverflow.com/questions/72213309',
  },
  {
    match: '711web.com',
    evidence: 'https://711web.com/html-css-scroll-view-on-nested-elements/',
    original: 'https://stackoverflow.com/questions/69451521/css-scroll-perspective-on-nested-elements',
  },
  {
    match: 'www.binarydevelop.com',
    evidence: 'https://www.binarydevelop.com/article/id-75271',
    original: 'https://stackoverflow.com/questions/6118922',
  },
  {
    match: 'so.muouseo.com',
    evidence: 'https://so.muouseo.com/qa/qnw6rlv4p6ok.html',
    original: 'https://stackoverflow.com/questions/68537601',
  },
  {
    match: 'peaku.co/questions',
    evidence: 'https://peaku.co/questions/8041-how-to-deploy-nextjs-with-nginx',
    original: 'https://stackoverflow.com/questions/64386737',
    note: 'path only: peaku.co is a jobs platform; its /questions pages republish Stack Overflow',
  },
  {
    match: 'solveforum.com',
    evidence:
      'https://solveforum.com/forums/threads/solved-authorization-error-error-400-redirect_uri_mismatch-on-c.650652/',
    original: 'https://stackoverflow.com/questions/71420434',
  },
  {
    match: 'www.edureka.co/community',
    evidence: 'https://www.edureka.co/community/185077/sql-group-by-with-an-order-by',
    original: 'https://stackoverflow.com/questions/27983',
    note: 'path only: edureka.co is a training company; its /community pages republish Stack Overflow',
  },
  {
    match: 'itecnote.com',
    evidence: 'https://itecnote.com/tecnote/python-split-rows-in-pandas-dataframe/',
    original: 'https://stackoverflow.com/questions/58523316',
  },
  {
    match: 'digitrain.ru',
    evidence: 'https://digitrain.ru/questions/60314547/',
    original: 'https://stackoverflow.com/questions/60314547',
  },
  {
    match: 'prograide.com',
    evidence:
      'https://prograide.com/pregunta/5898/autorisation-google-oauth-2---erreur--redirect_uri_mismatch',
    original: 'https://stackoverflow.com/questions/11485271',
  },
  {
    match: 'dovov.com',
    evidence: 'https://csharp.dovov.com/65407/nhibernate-coalesce%e9%97%ae%e9%a2%98.html',
    original: 'https://stackoverflow.com/questions/26364036',
  },
  {
    match: 'oomake.com',
    evidence: 'https://oomake.com/question/1251424',
    original: 'https://stackoverflow.com/questions/5102436',
  },
  {
    match: 'ajaxhispano.com',
    evidence: 'https://ajaxhispano.com/ask/google-oauth-2-authorization-error-redirect-uri-mismatch-10280/',
    original: 'https://stackoverflow.com/questions/11485271',
  },
  {
    match: 'www.codebaoku.com',
    evidence: 'http://www.codebaoku.com/question/question-cd-226679.html',
    original: 'https://stackoverflow.com/questions/11485271',
  },
  {
    match: 'daplus.net',
    evidence:
      'http://daplus.net/authentication-google-oauth-2-%EC%9D%B8%EC%A6%9D-%EC%98%A4%EB%A5%98-redirect_uri_mismatch/',
    original: 'https://stackoverflow.com/questions/11485271',
  },
  {
    match: 'doraprojects.net',
    evidence:
      'https://doraprojects.net/questions/11485271/google-oauth-2-authorization-error-redirect-uri-mismatch',
    original: 'https://stackoverflow.com/questions/11485271',
  },
  {
    match: 'iteramos.com',
    evidence:
      'https://www.iteramos.com/pregunta/14081/autorizacion-de-google-oauth-2---error-redirect_uri_mismatch',
    original: 'https://stackoverflow.com/questions/11485271',
  },
  {
    match: 'www.anycodings.com',
    evidence:
      'https://www.anycodings.com/questions/google-oauth-20-api-authentication-error-error-400-redirecturimismatch-does-not-comply-with-policy-django-app',
    original: 'https://stackoverflow.com/questions/68764885',
  },
  {
    match: 'www.javafixing.com',
    evidence: 'https://www.javafixing.com/2021/12/fixed-commentthreads-insert-gives-403.html',
    original: 'https://stackoverflow.com/questions/50828577',
  },
  {
    match: 'xstack.us',
    evidence: 'http://xstack.us/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'shenghuobao.net',
    evidence: 'http://shenghuobao.net/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'overstack.in',
    evidence: 'http://qa.overstack.in/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'zaizhele.cn',
    evidence: 'https://qa.zaizhele.cn/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'zaizhele.net',
    evidence: 'https://qa.zaizhele.net/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'xstack.ru',
    evidence: 'https://qa.xstack.ru/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'mlink.in',
    evidence: 'https://qa.mlink.in/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'jonic.cn',
    evidence: 'https://qa.jonic.cn/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'jike.in',
    evidence: 'https://qa.jike.in/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: '16892.net',
    evidence: 'https://qa.16892.net/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'vigges.net',
    evidence: 'https://qa.vigges.net/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: '55276.net',
    evidence: 'https://qa.55276.net/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'shenzhenjia.net',
    evidence: 'https://www.shenzhenjia.net/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'shenzhenjia.cn',
    evidence: 'https://qa.shenzhenjia.cn/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: '9ishenzhen.com',
    evidence: 'https://qa.9ishenzhen.com/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'vigge.net',
    evidence: 'https://qa.vigge.net/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'vigge.cn',
    evidence: 'https://qa.vigge.cn/qa/?qa=637288/',
    original: 'https://stackoverflow.com/questions/56516894/',
  },
  {
    match: 'web-dev-qa-db-fra.com',
    evidence:
      'https://www.web-dev-qa-db-fra.com/fr/php/comment-installer-lextension-gmp-pour-php-7.2-en-utilisant-mamp-sur-osx/838751599/',
    original: 'https://stackoverflow.com/q/50435455',
  },
  {
    match: 'yaoply.com',
    evidence: 'https://yaoply.com/items/decrypt-rijndael-128-string-with-php-openssl-return-empty',
    original:
      'https://stackoverflow.com/questions/66596540/decrypt-rijndael-128-string-with-php-openssl-return-empty',
  },
  {
    match: 'techhelpnotes.com',
    evidence: 'https://techhelpnotes.com/postgresql-how-to-manage-postgres-enum-type-in-django/',
    original: 'https://stackoverflow.com/questions/67819553/how-to-manage-postgres-enum-type-in-django',
  },
  {
    match: 'www.querythreads.com',
    evidence:
      'https://www.querythreads.com/generics-error-with-forward-ref-property-ref-does-not-exist-on-type-intrinsic-attributes/',
    original: 'https://stackoverflow.com/q/57750777/13765033',
  },
  {
    match: 'www.appsloveworld.com',
    evidence:
      'https://www.appsloveworld.com/reactjs/100/11/generics-error-with-forwardref-property-ref-does-not-exist-on-type-intrinsica',
    original: 'https://stackoverflow.com/q/57750777/13765033',
  },
  {
    match: 'webdevask.com',
    evidence: 'https://webdevask.com/items/laravel-model-is-not-getting-data',
    original: 'https://stackoverflow.com/questions/73267978',
  },
  {
    match: 'arip-photo.org',
    evidence: 'https://ja.arip-photo.org/477708-why-is-zfs-so-much-CJTRXD',
    original: 'https://serverfault.com/questions/858610/why-is-zfs-so-much-slower-than-ext4-and-btrfs/864574',
  },
  {
    match: 'www.answerlib.com',
    evidence: 'https://www.answerlib.com/question/128159/command-makeseeder-is-not-defined-in-lumen-52.html',
    original: 'https://stackoverflow.com/q/37928277',
  },
  {
    match: 'fluffyfables.com',
    evidence: 'https://ja.fluffyfables.com/622335-article-pytesseract-tesseractnotfound-error-tesseract-is',
    original: 'https://stackoverflow.com/q/50951955',
  },
  {
    match: 'fullstackuser.com',
    evidence: 'https://fullstackuser.com/questions/142923/argparse-subparser-monolithic-help-output',
    original: 'https://stackoverflow.com/questions/20094215/argparse-subparser-monolithic-help-output',
  },
  {
    match: 'exchangetuts.com',
    evidence:
      'https://exchangetuts.com/is-there-is-a-way-to-do-something-like-rails-server-sandbox-1639967255556852',
    original:
      'https://stackoverflow.com/questions/18006591/is-there-is-a-way-to-do-something-like-rails-server-sandbox',
  },
  {
    match: 'splunktool.com',
    evidence: 'https://splunktool.com/how-to-use-mysqlconnection-db-pool-with-python-flask',
    original: 'https://stackoverflow.com/questions/24101056/',
  },
  {
    match: 'jtuto.com',
    evidence: 'https://jtuto.com/poetry-add-removes-all-metadata-files-entries/',
    original:
      'https://stackoverflow.com/questions/73213527/poetry-add-package-removes-all-metadata-files-entries',
  },
  {
    match: 'bitcoden.com',
    evidence: 'https://bitcoden.com/answers/exclude-file-from-git-diff',
    original: 'https://stackoverflow.com/questions/10415100/exclude-file-from-git-diff',
  },
  {
    match: '9to5answer.com',
    evidence: 'https://9to5answer.com/jinja2-if-statement-in-vs-equals-on-dict',
    original: 'https://stackoverflow.com/questions/22238265/jinja2-if-statement-in-vs-equals-on-dict',
  },
  {
    match: 'www.5axxw.com',
    evidence: 'https://www.5axxw.com/questions/content/8pxpsb',
    original:
      'https://stackoverflow.com/questions/70786700/how-to-change-the-interface-key-value-string-to-key-string-string',
  },
  {
    match: 'questu.ru',
    evidence: 'https://questu.ru/questions/64261995/',
    original: 'https://stackoverflow.com/questions/64261995',
  },
  {
    match: 'www.mejorcodigo.com',
    evidence: 'https://www.mejorcodigo.com/p/10912.html',
    original: 'https://stackoverflow.com/questions/54333951',
  },
  {
    match: 'itecnotes.com',
    evidence: 'https://itecnotes.com/server/openvpn-needs-a-gateway-parameter-fo-a-route-option/',
    original: 'https://serverfault.com/questions/806414/',
  },
  {
    match: 'www.javaer101.com',
    evidence: 'https://www.javaer101.com/ja/article/2084594.html',
    original: 'https://stackoverflow.com/questions/35394937/',
  },
  {
    match: 'www.debugcn.com',
    evidence: 'https://www.debugcn.com/ja/article/106110221.html',
    original: 'https://stackoverflow.com/questions/14452824',
  },
  {
    match: 'www.debugko.com',
    evidence: 'https://www.debugko.com/article/25OdKAAOyMaK7Be9.html',
    original:
      'https://stackoverflow.com/questions/49185275/aws-s3-sdk-how-do-i-set-thread-pool-size/49185892#49185892',
  },
  {
    match: 'codeutility.org',
    evidence:
      'https://codeutility.org/2023/02/10/hadoop-error-1070-could-not-resolve-todate-using-imports-java-lang-org-apache-pig-builtin-org-apache-pig-impl-builtin-code-utility/',
    original: 'https://stackoverflow.com/q/43490287',
  },
  {
    match: 'copyprogramming.com',
    evidence: 'https://copyprogramming.com/howto/how-to-save-data-from-json-in-sqlite-in-android',
    original: 'https://stackoverflow.com/q/6563118',
  },
  // GitHub copies (arosh/ublacklist-github-translation evidence.md, CC0-1.0)
  {
    match: 'lightrun.com/answers',
    evidence: 'https://lightrun.com/answers/microsoft-typescript-pipeflowchain-type-support',
    original: 'https://github.com/microsoft/TypeScript/issues/30370',
    note: 'path only: lightrun.com is a developer-tools company; its /answers pages republish GitHub issues',
  },
  {
    match: 'giters.com',
    evidence: 'https://giters.com/arosh/ublacklist-stackoverflow-translation/issues/51',
    original: 'https://github.com/arosh/ublacklist-stackoverflow-translation/issues/51',
  },
  {
    match: 'githubmemory.com',
    evidence: 'https://githubmemory.com/repo/arosh/ublacklist-stackoverflow-translation/issues/51',
    original: 'https://github.com/arosh/ublacklist-stackoverflow-translation/issues/51',
  },
  {
    match: 'www.wenyanet.com',
    evidence: 'https://www.wenyanet.com/opensource/ja/5ff3071877c41a72a418b148.html',
    original: 'https://github.com/BBE78/cypress-sonarqube-reporter',
  },
  {
    match: 'codesti.com',
    evidence: 'https://codesti.com/issue/arosh/ublacklist-stackoverflow-translation/51',
    original: 'https://github.com/arosh/ublacklist-stackoverflow-translation/issues/51',
  },
  {
    match: 'awesomeopensource.com',
    evidence: 'https://awesomeopensource.com/project/jgm/pandoc',
    original: 'https://github.com/pandoc/pandoc',
  },
  {
    match: 'www.findbestopensource.com',
    evidence: 'https://www.findbestopensource.com/product/robertoaloi-erlang-web',
    original: 'https://github.com/robertoaloi/erlang-web',
  },
  {
    match: 'githubhelp.com',
    evidence: 'https://githubhelp.com/arosh/ublacklist-stackoverflow-translation',
    original: 'https://github.com/arosh/ublacklist-stackoverflow-translation',
  },
  {
    match: 'reposhub.com',
    evidence: 'https://reposhub.com/ruby/database-tools/soundcloud-lhm.html',
    original: 'https://github.com/soundcloud/lhm',
  },
  {
    match: 'githubplus.com',
    evidence: 'https://githubplus.com/docker-library/php',
    original: 'https://github.com/docker-library/php',
  },
  {
    match: 'pythonrepo.com',
    evidence: 'https://pythonrepo.com/repo/tensorflow-tensorflow--python-deep-learning',
    original: 'https://github.com/tensorflow/tensorflow',
  },
  {
    match: 'bestofcpp.com',
    evidence: 'https://bestofcpp.com/repo/GaryOderNichts-Bloopair-cpp-network',
    original: 'https://github.com/GaryOderNichts/Bloopair',
  },
  {
    match: 'kandi.openweaver.com',
    evidence: 'https://kandi.openweaver.com/typescript/HelloRusk/qiita-trend-api',
    original: 'https://github.com/HelloRusk/qiita-trend-api',
    note: 'upstream note: The site distributes copies of Stack Overflow QAs under the heading "Community Discussions."',
  },
  {
    match: 'issueantenna.com',
    evidence: 'https://issueantenna.com/repo/arosh/ublacklist-stackoverflow-translation/issues',
    original: 'https://github.com/arosh/ublacklist-stackoverflow-translation/issues',
  },
  {
    match: 'gitanswer.net',
    evidence:
      'https://gitanswer.net/method-eq-and-ne-overrides-class-object-in-an-incompatible-manner-regression-between-1-1-160-and-1-1-161-993201807',
    original: 'https://github.com/microsoft/pyright/issues/2287',
  },
  {
    match: 'issuehint.com',
    evidence: 'https://issuehint.com/issue/arosh/ublacklist-stackoverflow-translation/51',
    original: 'https://github.com/arosh/ublacklist-stackoverflow-translation/issues/51',
  },
  {
    match: 'rustrepo.com',
    evidence: 'https://rustrepo.com/repo/hyperium-hyper-rust-http-client',
    original: 'https://github.com/hyperium/hyper',
  },
  {
    match: 'githubrecord.com',
    evidence: 'https://githubrecord.com/issue/home-assistant/core/66291/1059421055',
    original: 'https://github.com/home-assistant/core/issues/66291',
  },
  {
    match: 'bleepcoder.com',
    evidence: 'https://bleepcoder.com/ja/metabase/419604485/time-is-showing-24-00-instead-of-00-00',
    original: 'https://github.com/metabase/metabase/issues/9538',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'githubja.com',
    evidence: 'https://githubja.com/tqdm/tqdm',
    original: 'https://github.com/tqdm/tqdm',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'www.gitmemory.com',
    evidence: 'https://www.gitmemory.com/issue/dbeaver/dbeaver/232/528912919',
    original: 'https://github.com/dbeaver/dbeaver/issues/232',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'githubmate.com',
    evidence: 'https://githubmate.com/repo/arosh/ublacklist-stackoverflow-translation/issues/51',
    original: 'https://github.com/arosh/ublacklist-stackoverflow-translation/issues/51',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'opensourcelibs.com',
    evidence: 'https://opensourcelibs.com/lib/pandoc',
    original: 'https://github.com/pandoc/pandoc',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'golangrepo.com',
    evidence: 'https://golangrepo.com/repo/uber-go-zap-go-logging-monitoring',
    original: 'https://github.com/uber-go/zap',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'gitmemory.cn',
    evidence: 'https://gitmemory.cn/repo/facebook/react',
    original: 'https://github.com/facebook/react',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'pythonissues.com',
    evidence: 'https://pythonissues.com/issues/2256430',
    original: 'https://github.com/pupil-labs/pupil/issues/920',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'openprojectrepo.com',
    evidence: 'https://openprojectrepo.com/project/kubernetes-kubernetes-go-miscellaneous',
    original: 'https://github.com/kubernetes/kubernetes',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'github.innominds.com',
    evidence: 'https://github.innominds.com/arosh/ublacklist-github-translation',
    original: 'https://github.com/arosh/ublacklist-github-translation',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'githubhot.com',
    evidence: 'https://githubhot.com/repo/mm1ke/gentoo-scripts/issues/1',
    original: 'https://github.com/mm1ke/gentoo-scripts/issues/1',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'curatedgo.com',
    evidence: 'https://curatedgo.com/r/golang-bindings-for-asticodego-asticoqui/index.html',
    original: 'https://github.com/asticode/go-asticoqui',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'bestrustcrates.com',
    evidence: 'https://bestrustcrates.com/p/once-installed-the-dtolnaycargo-expand/',
    original: 'https://github.com/dtolnay/cargo-expand',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'gitanswer.com',
    evidence:
      'https://gitanswer.com/pyo3-question-about-pymethods-cannot-be-used-with-lifetime-parameters-or-generics-rust-674792372',
    original: 'https://github.com/PyO3/pyo3/issues/1088',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'www.higithub.com',
    evidence: 'https://www.higithub.com/abrt/issue/retrace-server/433',
    original: 'https://github.com/abrt/retrace-server/pull/433',
    note: 'upstream marks the site as possibly closed',
  },
  {
    match: 'githublab.com',
    evidence: 'https://githublab.com/repository/arosh/ublacklist-stackoverflow-translation',
    original: 'https://github.com/arosh/ublacklist-stackoverflow-translation',
    note: 'upstream marks the site as possibly closed',
  },
]
