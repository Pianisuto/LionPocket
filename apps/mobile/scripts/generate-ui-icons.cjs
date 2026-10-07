// Uses the desktop's existing Lucide dependency. Run from the monorepo root.
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const lucide = require('lucide-react');
const sharp = require('sharp');
const path = require('path');
const icons = {home:'LayoutDashboard',plan:'CalendarClock',year:'ChartNoAxesColumnIncreasing',more:'Menu',left:'ChevronLeft',right:'ChevronRight',close:'X',plus:'Plus',filter:'SlidersHorizontal',up:'ArrowUpRight',down:'ArrowDownRight',pin:'Pin',dots:'Ellipsis',repeat:'Repeat2',card:'WalletCards',goal:'Target',data:'HardDrive',catalog:'Tags',check:'Check',arrowUp:'ArrowUp',arrowDown:'ArrowDown',search:'Search',calendar:'CalendarDays',moon:'Moon',sun:'Sun',settings:'Settings2',sync:'RefreshCw',lock:'LockKeyhole',device:'Smartphone',shield:'ShieldCheck',sliders:'SlidersVertical',trash:'Trash2',edit:'Pencil',wallet:'Wallet',upload:'Upload',download:'Download',copy:'Copy',server:'Server'};
Promise.all(Object.entries(icons).map(async ([name, component]) => {
 const svg = renderToStaticMarkup(React.createElement(lucide[component], {size:72, color:'#ffffff', strokeWidth:1.8}));
 await sharp(Buffer.from(svg)).png().toFile(path.join(__dirname,'../src/ui/assets',name+'@3x.png'));
})).catch(error=>{console.error(error);process.exitCode=1;});

// Android launcher/splash use the same existing desktop mark.
const fs = require('fs');
const desktopMark = path.join(__dirname,'../../desktop/assets/icon.png');
const res = path.join(__dirname,'../android/app/src/main/res');
async function launcher() {
 fs.copyFileSync(desktopMark, path.join(__dirname,'../src/ui/assets/lion.png'));
 for (const [density,size] of Object.entries({mdpi:48,hdpi:72,xhdpi:96,xxhdpi:144,xxxhdpi:192})) {
  await sharp(desktopMark).resize(size,size).png().toFile(path.join(res,`mipmap-${density}/ic_launcher.png`));
  const circle = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="white"/></svg>`);
  await sharp(desktopMark).resize(size,size).composite([{input:circle,blend:'dest-in'}]).png().toFile(path.join(res,`mipmap-${density}/ic_launcher_round.png`));
 }
 fs.mkdirSync(path.join(res,'drawable-nodpi'),{recursive:true});
 const mark = await sharp(desktopMark).resize(288,288).png().toBuffer();
 await sharp({create:{width:432,height:432,channels:4,background:'#00000000'}}).composite([{input:mark,left:72,top:72}]).png().toFile(path.join(res,'drawable-nodpi/ic_launcher_foreground.png'));
}
launcher().catch(error=>{console.error(error);process.exitCode=1;});
