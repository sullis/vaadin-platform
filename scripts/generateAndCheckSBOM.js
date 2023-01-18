#!/usr/bin/env node

// brew tap devops-kung-fu/homebrew-tap
// brew install devops-kung-fu/homebrew-tap/bomber
// brew install osv-scanner
// sudo go install github.com/google/osv-scanner/cmd/osv-scanner@v1

const asyncExec = require('util').promisify(require('child_process').exec);
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const VAADIN_LICENSE = 'https://vaadin.com/commercial-license-and-service-terms';
const testProject = path.resolve('vaadin-platform-sbom');
const licenseWhiteList = [
  'ISC',
  'MIT',
  '0BSD',
  'Apache-2.0',
  'CDDL',
  'CDDL-1.0',
  'GPL-2.0-with-classpath-exception',
  'LGPL-2.1-or-later',
  'LGPL-2.1-only',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'EPL-1.0',
  'EPL-2.0',
  'AFL-2.1',
  'MPL-1.1',
  'CC0-1.0',
  'CC-BY-4.0',
  'Zlib',
  'WTFPL',
  'http://www.gnu.org/licenses/old-licenses/lgpl-2.1.html',
  VAADIN_LICENSE,
  'https://www.highcharts.com/license'
];

const cveWhiteList = {}

const cmd = { useBomber: true, useOSV: true, useOWASP: true,
    hasOssToken: !!(process.env.OSSINDEX_USER && process.env.OSSINDEX_TOKEN)};
for (let i = 2, l = process.argv.length; i < l; i++) {
  switch (process.argv[i]) {
    case '--disable-bomber': cmd.useBomber = false; break;
    case '--disable-osv-scan': cmd.useOSV = false; break;
    case '--disable-owasp': cmd.useOWASP = false; break;
    case '--enable-full-owasp': cmd.useFullOWASP = true; break;
    case '--version': cmd.version = process.argv[++i]; break;
    default:
      console.log(`Usage: ${path.relative('.', process.argv[1])} 
        [--disable-bomber] [--disable-osv-scan] [--disable-owasp] [--enable-full-owasp] [--version x.x.x]`);
      process.exit(1);
  }
}

console.log(`Running ${process.argv[1]} with arguments: ${JSON.stringify(cmd)}`);

function log(...args) {
  process.stderr.write(`\x1b[0m> \x1b[0;32m${args}\x1b[0m\n`);
}
function out(...args) {
  process.stderr.write(`\x1b[2m\x1b[196m${args}\x1b[0m`);
}
function err(...args) {
  process.stderr.write(`\x1b[0;31m${args}\x1b[0m`);
}

function ghaStepReport(msg) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) {
    try {
      fs.accessSync(path.dirname(f), fs.constants.W_OK);
      fs.writeFileSync(f, msg);
    } catch (error) {
    }
  }
}

async function exec(order, ops) {
  ops = {...{throw: true, debug: true}, ...ops};
  log(`${order}${ops.output ? ` > ${ops.output}` : ''}`);
  return new Promise((resolve, reject) => {
    const cmd = order.split(/ +/)[0];
    const arg = order.split(/ +/).splice(1);
    let stdout = "", stderr = "";
    const ls = spawn(cmd, arg);
    ls.stdout.on('data', (data) => {
      stdout += data;
      (!ops.output && ops.debug) && out(data);
    });
    ls.stderr.on('data', (data) => {
      (ops.throw) && out(data);
      stderr += data;
    });
    ls.on('close', (code) => {
      ops.output && fs.writeFileSync(ops.output, stdout);
      if (ops.throw && code !== 0) {
        reject({ stdout, stderr, code });
      } else {
        resolve({ stdout, stderr, code });
      }
    });
  });
}
async function run(order, ops) {
  try {
    return await exec(order, ops);
  } catch (ret) {
    if (ops.throw) {
      err(`!! ERROR ${ret.code} !! running: ${order}!!\n${ops.output || !ops.debug ? ret.stdout : ''}`)
      process.exit(1);
    } else {
      return ret;
    }
  }
}

async function isInstalled(command) {
  if ((await exec(`which ${command}`, { debug: false, throw: false })).code) {
    err(`You need to install '${command}' command in your PATH to continue\n`);
    process.exit(1);
  }
}

async function consolidateSBoms(...boms) {
  let ret;
  boms.forEach(f => {
    const sbom = JSON.parse(fs.readFileSync(f));
    if (!ret) {
      ret = sbom;
    } else {
      ret.components = ret.components.concat(sbom.components);
      ret.dependencies = ret.dependencies.concat(sbom.dependencies);
    }
  });
  ret.components.forEach(c => {
    c.licenses && c.licenses.forEach(l => {
      if (/vaadin/.test(c.purl)) {
        if (l.expression) {
          l.expression = l.expression.replace(/SEE LICENSE IN [^\)]+/, VAADIN_LICENSE);
        }
        if (l.license && l.license.name == 'SEE LICENSE IN LICENSE') {
          l.license.url = VAADIN_LICENSE;
        }
      }
      l.expression && (l.license = { id: l.expression });
    });
    // See https://github.com/mapbox/jsonlint README
    if (/jsonlint-lines-primitives/.test(c.purl) && !c.licenses) {
      c.licenses = [{ license: { id: 'MIT' } }];
    }
  });
  return ret;
}

function sumarizeLicenses(f) {
  const sbom = JSON.parse(fs.readFileSync(f));
  const summary = {};
  sbom.components.forEach((e) => {
    let comp = decodeURIComponent(e.purl).replace(/[?#].*$/g, '');
    let lic = e.licenses && [...(e.licenses.reduce((p, l) => {
      return p.add(l.expression ? l.expression.replace(/[\(\)]/g, '') :
        (l.license.id || (!l.license.name || / /.test(l.license.name)) && l.license.url || l.license.name));
    }, new Set()))].join(' OR ');
    const addLic = (idx, l) => (summary[idx] = summary[idx] || []).push(l);
    if (!lic) {
      addLic(null, comp);
    } else {
      lic.split(/ +(?:OR|AND) +/).forEach(l => addLic(l, comp));
    }
  });
  return summary;
}

function sumarizeOSV(f, summary) {
  const res = JSON.parse(fs.readFileSync(f));
  res.results.forEach(r => {
    r.packages.forEach(p => {
      p.vulnerabilities.forEach(v => {
        v.affected.forEach(a => {
          const pkg = a.package.purl + "@" + p.package.version;
          summary[pkg] = summary[pkg] || {};
          v.aliases.forEach(id => {
            summary[pkg][id] = summary[pkg][id] || {};
            summary[pkg][id].title = v.summary;
            summary[pkg][id].details = v.details;
            (summary[pkg][id].scanner = summary[pkg][id].scanner || []).push('osv-scan');
          });
        });
      });
    });
  });
  return summary;
}

function sumarizeBomber(f, summary) {
  const res = JSON.parse(fs.readFileSync(f));
  (res.packages || []).forEach(p => {
    p.vulnerabilities.forEach(v => {
      const pkg = p.coordinates.replace(/\?.+/, '');
      const id = v.id;
      summary[pkg] = summary[pkg] || {};
      summary[pkg][id] = summary[pkg][id] || {};
      summary[pkg][id].title = v.title;
      summary[pkg][id].details = v.description;
      (summary[pkg][id].scanner = summary[pkg][id].scanner || []).push(`${f.includes('oss') ? 'oss' : 'osv'}-bomber`);
    });
  });
  return summary;
}

function sumarizeOWASP(f, summary) {
  const res = JSON.parse(fs.readFileSync(f));
  res.dependencies.forEach(d => {
    (d.vulnerabilities || []).forEach(v => {
      const id = v.name;
      (d.packages || []).map(p => p.id).forEach(pkg => {
        summary[pkg] = summary[pkg] || {};
        summary[pkg][id] = summary[pkg][id] || {};
        summary[pkg][id].title = summary[pkg][id].title || `${v.description.substring(0, 120)}…`;
        summary[pkg][id].details = v.description;
        (summary[pkg][id].scanner = summary[pkg][id].scanner || []).push('owasp');
      });
    })
  });
  return summary;
}

function checkLicenses(licenses) {
  let ret = "";
  Object.keys(licenses).forEach(lic => {
    if (licenseWhiteList.indexOf(lic) < 0) {
      ret += `Found invalid license '${lic}' in: ${licenses[lic].join(' and ')}\n`;
    }
  });
  return ret;
}

function checkVunerabilities(vuls) {
  let err = false;
  let msg = "";
  Object.keys(vuls).forEach(v => {
    const cves = Object.keys(vuls[v]).sort().join(', ');
    err = err && (!cveWhiteList[v] || cves !== cveWhiteList[v].sort().join(', '));
    msg += `Found vulnerabilities in: ${v} [${Object.keys(vuls[v]).join(', ')}]\n`;
  });
  return {err, msg};
}

function reportLicenses(licenses) {
  let md = "", html = "";
  Object.keys(licenses).sort((a, b) => licenseWhiteList.indexOf(a) - licenseWhiteList.indexOf(b)).forEach(lic => {
    const status = licenseWhiteList.indexOf(lic) < 0 ? '🚫' : '✅';
    const license = `${lic}`;
    const summary = `<details><summary>${licenses[lic].length}</summary><ul><li><code>${licenses[lic].join('</code><li><code>').replace(/@(\d)/g, ' $1')}</code></ul></details>`
    html += `<tr><td>${status}</td><td><pre>${license}</pre></td><td>${summary}</td></tr>\n`
    md += `|${status}|\`${license}\`|${summary}|\n`;
  });
  html && (html = `<table><tr><th></th><th>License</th><th>Packages</th></tr>\n${html}</table>\n`);
  md && (md = "|  | License | Packages |\n|-------|--------|-------|\n" + md);
  return {md, html};
}

function reportVulnerabilities(vuls) {
  let md = "", html = "";
  Object.keys(vuls).forEach(v => {
    html += `<tr><td><code>${v}</code></td><td><ul><li>${Object.keys(vuls[v]).map(o =>
      `<a href="https://nvd.nist.gov/vuln/detail/${o}">${o}</a> <i>${vuls[v][o].title}</i> (${[...new Set(vuls[v][o].scanner)].join(',')})`).join('<li>')}</ul></td></tr>\n`;
    md += `|\`${v}\`|<ul><li>${Object.keys(vuls[v]).map(o =>
      `[${o}](https://nvd.nist.gov/vuln/detail/${o}) _${vuls[v][o].title}_ (${[...new Set(vuls[v][o].scanner)].join(',')})`).join('<li>')}</ul>\n`;
  });
  html && (html = `<table><tr><th>Package</th><th>CVEs</th>\n${html}</table>\n`)
  md && (md = "| Package | CVEs |\n|-------|--------|\n" + md);
  return {md, html};
}

function reportFileContent(title, file, filter = c => c) {
  const content = filter(fs.readFileSync(file).toString());
  return `\n<details><summary><h3 style="display: inline">${title}</h3></summary><pre>\n${content}\n</pre></details>\n`;
}

async function main() {
  await isInstalled('bomber');
  await isInstalled('osv-scanner');
  await isInstalled('dependency-check');
  await isInstalled('mvn');

  if (cmd.version) {
    await run(`mvn -ntp -N -B -DnewVersion=${cmd.version} -Psbom versions:set -q`);
  }

  await run(`./scripts/generateBoms.sh`, { debug: false });
  await run('mvn -ntp -B clean install -T 1C -q');

  log(`cd ${testProject}`);
  process.chdir(testProject);

  log(`cleaning package.json`);
  fs.existsSync('package.json') && fs.unlinkSync('package.json');

  await run('mvn clean package -ntp -B -Pproduction -DskipTests -q');
  await run('mvn dependency:tree -ntp -B', { output: 'target/tree-maven.txt' });
  await run('mvn -ntp -B org.cyclonedx:cyclonedx-maven-plugin:makeAggregateBom -q');
  await run('npm ls --depth 6 --omit dev', { output: 'target/tree-npm.txt' });

  await run('npm install');
  await run('npm install @cyclonedx/cyclonedx-npm');
  await run('npx @cyclonedx/cyclonedx-npm --omit dev --output-file target/bom-npm.json --output-format JSON');

  log(`generating 'bom-vaadin.js'`);
  const sbom = await consolidateSBoms('target/bom.json', 'target/bom-npm.json');
  fs.writeFileSync('target/bom-vaadin.json', JSON.stringify(sbom, null, 2));
  const licenses = sumarizeLicenses('target/bom-vaadin.json');

  const vulnerabilities = {}
  if (cmd.useBomber) {
    const cmdBomber = `bomber scan target/bom-vaadin.json --output json`;
    await run(cmdBomber, { output: 'target/bomber-osv-report.json' });
    sumarizeBomber('target/bomber-osv-report.json', vulnerabilities);
    if (cmd.hasOssToken) {
      await run(`${cmdBomber} --provider ossindex --username ${process.env.OSSINDEX_USER} --token ${process.env.OSSINDEX_TOKEN}`,
        { output: 'target/bomber-oss-report.json' });
      sumarizeBomber('target/bomber-oss-report.json', vulnerabilities);
    }
  }

  if (cmd.useOSV) {
    await run('osv-scanner --sbom=target/bom-vaadin.json --json', { output: 'target/osv-scanner-report.json' , throw: false});
    sumarizeOSV('target/osv-scanner-report.json', vulnerabilities);
  }

  if (cmd.useOWASP) {
    // https://github.com/jeremylong/DependencyCheck/issues/4293
    // https://github.com/jeremylong/DependencyCheck/issues/1947
    fs.unlinkSync('package-lock.json')
    await run('mvn org.owasp:dependency-check-maven:check -Dformat=JSON -q', { throw: false });
    sumarizeOWASP('target/dependency-check-report.json', vulnerabilities);
  }

  if (cmd.useFullOWASP) {
    await run('dependency-check -f JSON -f HTML --prettyPrint --out target --scan .');
    sumarizeOWASP('target/dependency-check-report.json', vulnerabilities);
  }

  const errLic = checkLicenses(licenses);
  const errVul = checkVunerabilities(vulnerabilities).err;
  const msgVul = checkVunerabilities(vulnerabilities).msg;
  let md = "";
  let html = `<style>
    body {max-width: 700px; margin: auto; font-family: arial}
    table {width: 100%; border-collapse: collapse; font-size: 14px}
    table, th, td {border: solid 1px grey; vertical-align: top; padding: 5px 1px 5px 8px}
    body > * {padding-top: 1em}
  </style>\n<h2>Vaadin Platform ${cmd.version} Dependencies Report</h2>\n`;

  if (errVul) {
    err(`- 🚫 Vulnerabilities:\n\n${msgVul}\n`);
    md += `\n### 🚫 Found Vulnerabilities\n`;
    html += `\n<h3>🚫 Found Vulnerabilities</h3>\n`
  } else if (msgVul) {
    err(`- 🟠 Known Vulnerabilities:\n\n${msgVul}\n`);
    md += `\n### 🟠 Known Vulnerabilities\n`;
    html += `\n<h3>🟠 Known Vulnerabilities</h3>\n`;
  } else {
    md += `\n### ✅ No Vulnerabilities\n`;
    html += `\n<h3>✅ No Vulnerabilities</h3>\n`;
  }
  md += reportVulnerabilities(vulnerabilities).md;
  html += reportVulnerabilities(vulnerabilities).html;
  if (errLic) {
    err(`- 🚫 License errors:\n\n${errLic}\n`);
    md += `\n### 🚫 Found License Issues\n`;
    html += `\n<h3>>🚫 Found License Issues</h3>\n`;
  } else {
    md += `\n### ✅ Licenses Report\n`;
    html += `\n<h3>✅ Licenses Report</h3>\n`;
  }
  md += reportLicenses(licenses).md;
  html += reportLicenses(licenses).html;
  let cnt = reportFileContent("Maven Dependency Tree", 'target/tree-maven.txt', c => {
    return c.split('\n').map(l => l.replace(/^\[INFO\] +/, ''))
      .filter(l => l.length && !/^(Scanning|Building|---|Build|Total|Finished|BUILD)/.test(l)).join('\n');
  });
  md += cnt;
  html += cnt;
  cnt = reportFileContent("NPM Dependency Tree", 'target/tree-npm.txt', c => {
    return c.split('\n').map(l => l.replace(/ overridden$/, '')).filter(l => l.length && !/ deduped|UNMET OPTIONAL/.test(l)).join('\n');
  });
  md += cnt;
  html += cnt;

  ghaStepReport(md);
  fs.writeFileSync('target/dependencies.html', html);

  if (errLic || errVul) {
    process.exit(1);
  }
}

main();