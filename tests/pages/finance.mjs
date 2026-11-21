import { base, browser, done, fail, pass, axeBoth, fitsPhone } from "./common.mjs";

const page = await browser.newPage();
page.on("pageerror",error=>fail(error.message));
const journal = {
  gift:{date:"2026-11-21",purpose:"Stripe payment",lines:[
    {fund:"tournaments",gross:3000},{fund:"marketing",gross:2000,fee:175,donation:1825}
  ]},
  expense:{date:"2026-11-22",purpose:"Flyer printing",lines:[{fund:"marketing",spent:500}]},
  pending:{date:"2026-11-23",purpose:"Awaiting Stripe processing fee",lines:[{fund:"marketing",pending:300}]}
};
await page.setRequestInterception(true);
page.on("request",request=>{
  if (request.url().includes("/public/finance.json")) return request.respond({contentType:"application/json",headers:{"Access-Control-Allow-Origin":"*"},body:JSON.stringify(journal)});
  request.continue();
});
await page.goto(base+"/finance/marketing/");
await page.waitForSelector("#journal tbody tr");
const summary = await page.$eval("#totals",el=>el.textContent);
summary.includes("$18.25") && summary.includes("$13.25") ? pass("Fund shows settled gifts after fees and spending") : fail(summary);
(await page.$$eval("#journal tbody tr",rows=>rows.length===3 && rows.every(row=>row.cells[2].textContent==="Marketing")))
  ? pass("Fund ledger filters mixed receipts and shows pending gifts") : fail("Unexpected fund ledger");
await axeBoth(page,"Marketing fund");
await page.setViewport({width:390,height:844});
await fitsPhone(page,"Marketing ledger");
await page.goto(base+"/finance/admin/");
await page.select('[name="kind"]',"transfer");
(await page.$eval("#destination",el=>!el.hidden)) ? pass("Admin transfers identify both funds") : fail("Missing destination");
await axeBoth(page,"Finance administration");
await page.close();
await done();
