const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Root URL Keep-Alive ke liye
app.get('/', (req, res) => {
    res.send('E-Visitor Automation Scraper is Active & Fast!');
});

// Main Automation & Scraper Endpoint
app.all('/scrape', async (req, res) => {
    const targetUrl = req.query.url || req.body.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'URL parameter missing hai' });
    }

    let browser = null;

    try {
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote'
            ],
            defaultViewport: { width: 1280, height: 800 },
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();

        // SPEED OPTIMIZATION: Images, Fonts, aur Stylesheets Block karein
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Page Visit
        await page.goto(targetUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });

        // AUTOMATION STEPS (Agar Form Fill / Click karna ho):
        // Example: Pehle element ke aane ka wait karein
        try {
            await page.waitForSelector('body', { timeout: 5000 });
            
            // Agar kisi specific input/button ko automations se handle karna ho:
            /*
            if (req.body.search_term) {
                await page.type('#search_input', req.body.search_term);
                await page.click('#submit_button');
                await page.waitForNetworkIdle();
            }
            */
        } catch (e) {
            console.log('Element wait timeout, proceeding anyway...');
        }

        // Final HTML Content Extract karein
        const htmlContent = await page.content();

        await browser.close();

        return res.send(htmlContent);

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: 'Automation Error: ' + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server active on port ${PORT}`);
});
