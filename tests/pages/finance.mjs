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
for (const entry of Object.values(journal)) entry.date = "2020-11-20";
journal.bill = {date:"2020-11",purpose:"Club bill",lines:[{fund:"general",owed:700}]};
journal.repayment = {date:"2020-11-21",purpose:"Partial repayment",lines:[{fund:"general",spent:100,owed:-100}]};
journal.transfer = {date:"2020-11-22",purpose:"Fund transfer",lines:[{fund:"general",transfer:500},{fund:"tournaments",transfer:-500}]};
journal.future = {date:"2099-01-01",purpose:"Future payment",lines:[{fund:"general",gross:50000}]};
await page.goto(base+"/finance/");
await page.waitForSelector("#balance-sheet:not([hidden])");
const accounts = await page.$$eval("#balance-sheet tr",rows => Object.fromEntries(rows.filter(r=>r.querySelector("td")).map(r=>[r.cells[0].textContent,r.cells[1].textContent])));
const expected = {"Total assets":"$42.25","Total liabilities":"$6.00","General":"-$2.00","Marketing":"$13.25","Tournament operations":"$25.00","Total net assets":"$36.25","Total liabilities and net assets":"$42.25"};
Object.entries(expected).every(([label,amount])=>accounts[label]===amount)
  ? pass("Balance sheet reconciles settled cash, payables, reimbursements and internal fund transfers") : fail(JSON.stringify(accounts));
(await page.$eval("#statement-note",el=>el.textContent.includes("$3.00"))) ? pass("Pending payments are disclosed separately") : fail("Missing pending payment disclosure");
await fitsPhone(page,"Public balance sheet");
await axeBoth(page,"Public balance sheet");
await page.goto(base+"/finance/admin/");
await page.select('[name="kind"]',"transfer");
(await page.$eval("#destination",el=>!el.hidden)) ? pass("Admin transfers identify both funds") : fail("Missing destination");
await axeBoth(page,"Finance administration");
await page.close();
await done();
