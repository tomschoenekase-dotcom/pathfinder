/** Actual read-only retained-preview journeys; no injected decisions, browser
 * auth, Block Museum reads, denied-operation retries or retained fixture writes. */
const {createRequire}=require('node:module'),{mkdirSync,writeFileSync}=require('node:fs'),path=require('node:path');
const {strict:assert}=require('node:assert');
const localRequire=createRequire(path.join(process.cwd(),'apps/dashboard/package.json'));
const {chromium}=localRequire('@playwright/test');
async function main(){
 const output=process.argv[2];if(!output||!path.isAbsolute(output))throw new Error('One new absolute evidence directory is required');
 mkdirSync(output,{recursive:false});
 const base='http://127.0.0.1:58618',route='/dev-fixtures/prospect-research/territories';
 const browser=await chromium.launch({headless:true,channel:'msedge'}),checks=[],errors=[],journey={};let failure=null;
 const check=(label,value)=>{assert(value,label);checks.push(label)};
 try{
  const context=await browser.newContext({reducedMotion:'reduce'}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  const open=async query=>{const response=await page.goto(base+route+query,{waitUntil:'networkidle',timeout:120000});check('retained territory route responds with HTTP 200',response?.status()===200)};
  await open('');
  const labels=await page.locator('main > dl div').allTextContents();
  journey.populationReadback=(await page.locator('main').innerText()).split('\n').filter(text=>/total native CRM|import population|Chicago venues have|County checks still needed|Verified venue assignments/u.test(text));
  journey.metricLabels=labels;
  check('the running workspace separates all native and retained import populations',journey.populationReadback.some(text=>text.includes('total native CRM venues')&&text.includes('retained import population')));
  check('native county controls are not exposed by the read-only local adapter',await page.getByRole('button',{name:'Acquire county claim'}).count()===0&&await page.getByRole('button',{name:'Record human identity decision'}).count()===0);
  const pageTwoLink=page.getByRole('link',{name:'Next locations',exact:true});check('held record pagination has a second page',await pageTwoLink.count()===1);
  await pageTwoLink.click();await page.waitForLoadState('networkidle');
  check('location pagination changes only its own page parameter',new URL(page.url()).searchParams.get('recordsPage')==='2');
  await page.getByLabel('Territory or county',{exact:true}).fill('17031');await page.getByRole('button',{name:'Apply',exact:true}).click();await page.waitForLoadState('networkidle');
  check('catalog county-code search preserves the independent held-record page',new URL(page.url()).searchParams.get('recordsPage')==='2');
  const catalog=page.locator('section[aria-labelledby="territory-catalog"]');
  check('exact county-code search finds its one canonical owner',await catalog.locator('details').count()===1&&(await catalog.innerText()).includes('Cook'));
  await catalog.locator('summary').focus();await page.keyboard.press('Enter');
  const countyLink=catalog.getByRole('link',{name:/17031.*Cook/u});check('county membership is a navigable exact county filter',await countyLink.count()===1);
  await countyLink.click();await page.waitForLoadState('networkidle');
  const countyUrl=new URL(page.url());check('county navigation opens assigned venues for that exact county',countyUrl.searchParams.get('recordCountyGeoid')==='17031'&&countyUrl.searchParams.get('recordStatus')==='ASSIGNED'&&countyUrl.searchParams.get('recordScope')==='all');
  check('zero assigned records has an explicit non-exhaustive empty state',await page.getByText('No locations match these filters.',{exact:false}).count()===1);
  await open('?scope=corridor&query=Racine&recordScope=all&recordStatus=ASSIGNED&recordQuery=Apple%20Holler');
  const location=page.getByRole('link',{name:'Apple Holler',exact:true});check('assigned-location search finds the retained native Apple Holler record',await location.count()===1);
  await location.click();await page.getByRole('heading',{name:'Apple Holler',exact:true}).waitFor({timeout:30000});
  check('native record readback exposes current assignment evidence',await page.getByText('Current assignment evidence',{exact:true}).count()===1);
  check('readonly evidence inspection does not expose an approval control',await page.getByRole('button',{name:'Accept county evidence',exact:true}).count()===0&&await page.getByRole('button',{name:'Reopen county assignment',exact:true}).count()===0);
  const evidence=page.locator('details').filter({has:page.getByText('Current assignment evidence',{exact:true})});
  await evidence.locator('summary').focus();await page.keyboard.press('Enter');
  check('evidence source inspection is keyboard accessible',await evidence.getByRole('link',{name:'Authoritative county',exact:true}).isVisible());
  journey.assignedVenueId=new URL(page.url()).searchParams.get('venue');
  const full=page.getByRole('link',{name:'Full prospect record',exact:true});journey.nativeProspectHref=await full.getAttribute('href');
  check('the assigned location links to an existing native prospect detail',/^\/dev-fixtures\/prospect-research\/porg_/u.test(journey.nativeProspectHref??''));
  for(const width of [390,768,1440]){
   await page.setViewportSize({width,height:1000});
   check(`selected location and evidence have no horizontal overflow at ${width}`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({path:path.join(output,`selected-evidence-${width}.png`),fullPage:true});
  }
  await full.click();await page.waitForLoadState('networkidle');
  check('assigned-location journey reaches the running native prospect record',(await page.locator('main').innerText()).includes('Apple Holler'));
  const prod=await context.request.get('https://app.torchiko.com/admin/prospects/territories',{maxRedirects:0,timeout:30000});
  journey.normalHostedEntry={url:'https://app.torchiko.com/admin/prospects/territories',status:prod.status(),location:prod.headers().location??null,authenticated:false};
  check('no client runtime errors were observed during the read-only journey',errors.length===0);
  await context.close();
 }catch(error){failure=error.stack??String(error)}
 finally{await browser.close();const receipt={passed:!failure,checkCount:checks.length,checks,errors,journey,failure,finishedAt:new Date().toISOString(),readsOnly:true,hostedAuthenticationTested:false,syntheticWrites:0,retainedMutations:0};writeFileSync(path.join(output,'acceptance.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(receipt));if(failure)process.exitCode=1}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1});
