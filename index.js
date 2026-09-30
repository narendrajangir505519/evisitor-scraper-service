process.env.TZ = 'Asia/Kolkata';

const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');

let sharedBrowser = null;
let browserStarting = null;

const app = express();
app.use(express.json({ limit: '50mb' }));

const FIXED_BASE_URL = 'https://ballyfin.in';

const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 20000
});

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
    res.send('E-Visitor Automation Scraper is Active & Fast (Playwright)!');
});

async function sendCallback(callbackUrl, payload) {
    if (!callbackUrl) {
        console.log('callback_url nahi diya gaya.');
        return false;
    }

    try {
        console.log('Callback sending:', callbackUrl);
        const response = await axiosInstance.post(callbackUrl, payload, {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json' },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        console.log('Callback success:', response.status);
        return true;
    } catch (error) {
        console.error('Callback failed:', error.message);
        return false;
    }
}

function startCreateVisitorBackground(auth_storage, booking_data, callback_url) {
    setImmediate(async () => {
        try {
            console.log('BACKGROUND CREATE VISITOR STARTED');
            const result = await processCreateVisitor(auth_storage, booking_data);
            console.log('Background process completed:', result.status);

            if (callback_url) {
                await sendCallback(callback_url, {
                    status: result.status,
                    message: result.message || '',
                    updated_person_ids: result.updated_person_ids || [],
                    screenshot: result.screenshot || null,
                    error_screenshot: result.error_screenshot || null,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error('Background process fatal error:', error);
            if (callback_url) {
                await sendCallback(callback_url, {
                    status: 'failed',
                    message: error.message || 'Background automation failed',
                    updated_person_ids: [],
                    screenshot: null,
                    error_screenshot: null,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });
}

async function getBrowser() {
    if (sharedBrowser && sharedBrowser.isConnected()) {
        return sharedBrowser;
    }

    if (browserStarting) {
        return await browserStarting;
    }

    browserStarting = (async () => {
        const browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run'
            ]
        });

        browser.on('disconnected', () => {
            console.log('Browser disconnected, resetting reference...');
            sharedBrowser = null;
        });

        return browser;
    })();

    try {
        sharedBrowser = await browserStarting;
        return sharedBrowser;
    } finally {
        browserStarting = null;
    }
}

app.get('/debug-view', async (req, res) => {
    let browser = null;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        await page.goto('https://evisitor.rajasthan.gov.in/evisitor', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        const screenshotBuffer = await page.screenshot({ fullPage: true });
        res.set('Content-Type', 'image/png');
        return res.send(screenshotBuffer);
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

async function downloadImage(url, destPath) {
    if (!url) return false;
    try {
        const writer = fs.createWriteStream(destPath);
        const response = await axiosInstance({
            url,
            method: 'GET',
            responseType: 'stream'
        });
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(true));
            writer.on('error', (err) => {
                writer.close();
                reject(err);
            });
        });
    } catch (err) {
        console.error('Image Download Failed:', url, err.message);
        return false;
    }
}

// CREATE VISITOR AUTOMATION MAIN ENGINE
async function processCreateVisitor(auth_storage, booking_data) {
    const visitorsUrl = 'https://evisitor.rajasthan.gov.in/evisitor/user/visitors';
    let browser = null;
    let context = null;
    let page = null; 
    let tempFiles = [];
    const updatedPersonIds = [];

    try {
        browser = await getBrowser();
        context = await browser.newContext({
            viewport: { width: 1366, height: 900 },
            timezoneId: 'Asia/Kolkata',
            serviceWorkers: 'block'
        });

        let storageData = auth_storage;
        if (storageData && storageData.auth_storage) {
            storageData = storageData.auth_storage;
        }

        if (storageData) {
            await context.addInitScript((storage) => {
                try {
                    if (storage.localStorage) {
                        for (const [key, value] of Object.entries(storage.localStorage)) {
                            window.localStorage.setItem(key, value);
                        }
                    }
                    if (storage.sessionStorage) {
                        for (const [key, value] of Object.entries(storage.sessionStorage)) {
                            window.sessionStorage.setItem(key, value);
                        }
                    }
                } catch (e) {}
            }, storageData);
        }

        page = await context.newPage();

        console.log('Opening base portal to verify session...');
        await page.goto('https://evisitor.rajasthan.gov.in/evisitor', { waitUntil: 'commit' });
        
        if (storageData) {
            await page.evaluate((storage) => {
                if (storage.localStorage) {
                    Object.keys(storage.localStorage).forEach(k => localStorage.setItem(k, storage.localStorage[k]));
                }
                if (storage.sessionStorage) {
                    Object.keys(storage.sessionStorage).forEach(k => sessionStorage.setItem(k, storage.sessionStorage[k]));
                }
            }, storageData);
        }

        console.log('Navigating directly to Visitors Management Page...');
        await page.goto(visitorsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        if (page.url().includes('login') || !page.url().includes('/user/visitors')) {
            throw new Error('Session expire ho gaya hai ya invalid auth data hai.');
        }

        // Close any notification or update modal
        try {
            const updateBtn = page.locator('button:has-text("Update Now"), button:has-text("UPDATE NOW")').first();
            if (await updateBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await updateBtn.click();
                await page.waitForTimeout(1500);
            }
        } catch (e) {}

        // Click Create Check-In / Create Visitor button on the page
        console.log('Looking for Create Check-In / Create Visitor button...');
        const createBtn = page.locator('button:has-text("Create Check-In"), button:has-text("CREATE VISITOR"), button:has-text("Create Visitor")').first();
        await createBtn.waitFor({ state: 'visible', timeout: 15000 });
        await createBtn.click();

        // Verify Modal Opened
        await page.waitForSelector('.MuiModal-root', { state: 'visible', timeout: 10000 });
        await page.waitForTimeout(800);

        // Helper functions for filling React Controlled inputs and MUI Select Dropdowns
        const fillReactInput = async (selector, value) => {
            if (value === undefined || value === null || value === '') return;
            await page.waitForSelector(selector, { state: 'visible', timeout: 7000 });
            await page.evaluate(({ sel, val }) => {
                const el = document.querySelector(sel);
                if (!el) return;
                try { el.removeAttribute('disabled'); } catch (e) {}
                const isTa = el.tagName === 'TEXTAREA';
                const setter = Object.getOwnPropertyDescriptor((isTa ? HTMLTextAreaElement : HTMLInputElement).prototype, 'value')?.set;
                if (setter) setter.call(el, val);
                else el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            }, { sel: selector, val: String(value) });
        };

        const selectMuiDropdown = async (dropdownId, targetText) => {
            if (!targetText) return;
            const dropdown = page.locator(`#${dropdownId}`);
            await dropdown.waitFor({ state: 'visible', timeout: 7000 });
            await dropdown.click();
            await page.waitForTimeout(300);

            // Wait for listbox options to render
            await page.waitForSelector('li[role="option"]', { state: 'visible', timeout: 7000 });
            const optionClicked = await page.evaluate((textToMatch) => {
                const norm = v => String(v || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
                const need = norm(textToMatch);
                const options = Array.from(document.querySelectorAll('li[role="option"]'));
                
                let found = options.find(o => norm(o.innerText) === need);
                if (!found) {
                    found = options.find(o => norm(o.innerText).includes(need));
                }

                if (found) {
                    found.scrollIntoView({ behavior: 'instant', block: 'center' });
                    found.click();
                    return true;
                }
                return false;
            }, targetText);

            if (!optionClicked) {
                // Close dropdown if no match found
                await page.keyboard.press('Escape');
                console.warn(`Dropdown option "${targetText}" nahi mila for #${dropdownId}`);
            }
            await page.waitForTimeout(300);
        };

        // 1. FILL ROOM / BASE DETAILS
        console.log('Filling Room Details...');
        if (booking_data.room_number) {
            await fillReactInput('input[name="roomNumber"]', booking_data.room_number);
        }

        if (booking_data.check_in_date_time) {
            // Ensure format YYYY-MM-DDTHH:mm
            let formattedCheckIn = booking_data.check_in_date_time;
            if (formattedCheckIn.includes(' ') && !formattedCheckIn.includes('T')) {
                formattedCheckIn = formattedCheckIn.replace(' ', 'T');
            }
            await fillReactInput('input[name="checkInDateTime"]', formattedCheckIn);
        }

        if (booking_data.coming_from) {
            await fillReactInput('input[name="comingLocation"]', booking_data.coming_from);
        }

        if (booking_data.going_to) {
            await fillReactInput('input[name="goingLocation"]', booking_data.going_to);
        }

        if (booking_data.visit_reason || booking_data.visit_reason_type) {
            await selectMuiDropdown('mui-component-select-visitReasonType', booking_data.visit_reason || booking_data.visit_reason_type);
        }

        if (booking_data.note) {
            await fillReactInput('textarea[name="note"]', booking_data.note);
        }

        // 2. FILL GUEST(S) DETAILS
        const guests = booking_data.guests || [];
        console.log(`Processing ${guests.length} guest(s)...`);

        for (let i = 0; i < guests.length; i++) {
            const guest = guests[i];
            console.log(`Filling details for Guest ${i + 1}: ${guest.full_name || guest.name}`);

            // Name
            await fillReactInput('input[name="name"]', guest.full_name || guest.name || guest.guest_name);

            // Date of birth (YYYY-MM-DD)
            if (guest.dateOfBirth || guest.dob) {
                await fillReactInput('input[name="dateOfBirth"]', guest.dateOfBirth || guest.dob);
            }

            // Email
            if (guest.email) {
                await fillReactInput('input[name="email"]', guest.email);
            }

            // Gender
            if (guest.gender) {
                let gText = 'Male';
                const lowerG = String(guest.gender).trim().toLowerCase();
                if (lowerG === 'female' || lowerG === 'f') gText = 'Female';
                else if (lowerG === 'other' || lowerG === 'o') gText = 'Other';
                await selectMuiDropdown('mui-component-select-gender', gText);
            }

            // Mobile Number
            if (guest.mobile_number || guest.mobile) {
                await fillReactInput('input[name="mobileNumber"]', guest.mobile_number || guest.mobile);
            }

            // State
            if (guest.state || guest.stateCd) {
                await selectMuiDropdown('mui-component-select-stateCd', guest.state || guest.stateCd);
                await page.waitForTimeout(500); // allow district options to load
            }

            // District
            if (guest.district || guest.districtcd) {
                await selectMuiDropdown('mui-component-select-districtcd', guest.district || guest.districtcd);
                await page.waitForTimeout(300);
            }

            // Police Station (Optional)
            if (guest.pscode || guest.police_station) {
                await selectMuiDropdown('mui-component-select-pscode', guest.pscode || guest.police_station);
            }

            // Document Type
            const docType = guest.document_type || guest.documentType || guest.id_type || '';
            if (docType) {
                await selectMuiDropdown('mui-component-select-documentType', docType);
                await page.waitForTimeout(500); // Wait for documentNumber input to enable
            }

            // Document Number
            const docNumber = guest.document_number || guest.documentNumber || guest.id_number || guest.doc_number;
            if (docNumber) {
                await fillReactInput('input[name="documentNumber"]', docNumber);
            }

            // Address
            if (guest.address) {
                await fillReactInput('textarea[name="address"]', guest.address);
            }

            // Document File Upload
            let docUrl = guest.document_url || guest.document_url_2 || null;
            if (docUrl) {
                if (typeof docUrl === 'string' && docUrl.startsWith('/')) {
                    docUrl = `${FIXED_BASE_URL}${docUrl}`;
                }

                if (typeof docUrl === 'string' && docUrl.startsWith('http')) {
                    const ext = docUrl.toLowerCase().endsWith('.pdf') ? 'pdf' : 'jpg';
                    const localDocPath = path.join('/tmp', `doc_g${i + 1}_${Date.now()}.${ext}`);
                    const ok = await downloadImage(docUrl, localDocPath);

                    if (ok && fs.existsSync(localDocPath)) {
                        // 25KB Portal requirement check
                        const stats = fs.statSync(localDocPath);
                        if (stats.size < 26000) {
                            const padding = Buffer.alloc(26000 - stats.size, 0);
                            fs.appendFileSync(localDocPath, padding);
                        }
                        tempFiles.push(localDocPath);

                        const fileInput = page.locator('input[type="file"]').first();
                        await fileInput.setInputFiles(localDocPath);
                        await page.waitForTimeout(800);
                    }
                }
            }

            // Click "Add" button
            console.log(`Clicking Add button for Guest ${i + 1}...`);
            const addBtn = page.locator('button.MuiButton-colorSuccess', { hasText: /^Add$/ }).first();
            await addBtn.waitFor({ state: 'visible', timeout: 5000 });
            await addBtn.click();

            // Check for Form Errors after clicking Add
            await page.waitForTimeout(1000);
            const errors = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.Mui-error, .MuiFormHelperText-root.Mui-error'))
                    .map(e => e.innerText.trim())
                    .filter(t => t.length > 0);
            });

            if (errors.length > 0) {
                const uniqueErrors = [...new Set(errors)].join(' | ');
                throw new Error(`Guest ${i + 1} validation failed: ${uniqueErrors}`);
            }

            if (guest.person_pk !== undefined && guest.person_pk !== null) {
                updatedPersonIds.push(guest.person_pk);
            }
        }

        // 3. FINAL SUBMIT CHECK-IN
        console.log('Submitting Final Check-In...');
        const submitCheckInBtn = page.locator('button:has-text("Submit Check-In")').first();
        await submitCheckInBtn.waitFor({ state: 'visible', timeout: 10000 });
        await submitCheckInBtn.click();

        // Wait for Toast notification
        let toastMessage = 'Visitor check-in submitted successfully.';
        try {
            await page.waitForSelector('.Toastify__toast', { timeout: 6000 });
            toastMessage = await page.evaluate(() => document.querySelector('.Toastify__toast')?.innerText.trim() || 'Submitted');
        } catch (e) {}

        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        await context.close();

        return { status: 'success', message: toastMessage, updated_person_ids: updatedPersonIds };
    } catch (error) {
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });

        let errorScreenshotBase64 = null;
        if (page && !page.isClosed()) {
            try {
                const buffer = await page.screenshot({ fullPage: true });
                errorScreenshotBase64 = buffer.toString('base64');
            } catch (screenshotError) {
                console.error("Screenshot capture failed:", screenshotError);
            }
        }

        if (context) await context.close();

        return { 
            status: 'failed', 
            message: error.message,
            error_screenshot: errorScreenshotBase64 ? `data:image/png;base64,${errorScreenshotBase64}` : null 
        };
    }
}

app.post('/create-visitor', async (req, res) => {
    try {
        const { auth_storage, booking_data, callback_url } = req.body;

        if (!booking_data) {
            return res.status(400).json({ status: 'failed', message: 'booking_data required hai.' });
        }

        if (!booking_data.guests || !Array.isArray(booking_data.guests) || booking_data.guests.length === 0) {
            return res.status(400).json({ status: 'failed', message: 'booking_data.guests empty hai.' });
        }

        console.log('Create visitor request received. Guests:', booking_data.guests.length);

        startCreateVisitorBackground(auth_storage, booking_data, callback_url);

        return res.status(202).json({
            status: 'processing',
            message: 'Visitor automation background mein start ho gayi hai.',
            callback_enabled: !!callback_url,
            guests: booking_data.guests.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Create visitor request error:', error.message);
        return res.status(500).json({
            status: 'failed',
            message: error.message || 'Unable to start visitor automation.'
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
