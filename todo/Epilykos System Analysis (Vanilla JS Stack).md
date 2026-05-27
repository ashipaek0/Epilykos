# **Epilykos System Analysis: Flaws, Bugs, and UI/UX Design Review**

**Constraint:** Strict adherence to the existing Vanilla HTML/CSS/JS and Node.js stack. No React migration.

## **1\. Architectural & Logic Flaws**

### **A. Brittle State Management & DOM Coupling**

* **The Flaw:** Components in /public/js/components/\*.js tightly couple state to DOM manipulation. When the dashboard receives a payload (e.g., via /public/js/updater.js or api.js), it likely iterates through active components and calls an .update(data) method.  
* **The Bug:** If the DOM element is missing or fails to render, the JavaScript throws a TypeError: Cannot read properties of null (reading 'querySelector'), halting the execution thread and stopping all subsequent component updates.  
* **Vanilla Fix:** Implement a centralized Pub/Sub (Observer) pattern in utils.js. Components should subscribe to specific data keys (e.g., eventBus.subscribe('pv\_power', updateUI)) and fail gracefully using optional chaining (this.element?.querySelector(...)).

### **B. Charting Memory Leaks (charts.js)**

* **The Flaw:** When the dashboard dynamically updates or re-renders charts (like Power or Energy charts), it often initializes a new chart instance on the same \<canvas\> without destroying the previous one.  
* **The Bug:** Over time, especially on an always-on display like a tablet, this causes a massive memory leak (WebGL/Canvas contexts are not garbage collected), eventually crashing the browser or slowing the device to a crawl.  
* **Vanilla Fix:** Keep references to chart instances. Before calling new Chart(...) or equivalent, check if the instance exists and call chartInstance.destroy() or simply chartInstance.update() with mutated data arrays.

### **C. Unsafe Data Parsing & Null Handling**

* **The Flaw:** Inverter protocols (Modbus, Solarman, MQTT via /modules/\*) occasionally drop packets or return null/undefined for certain registers.  
* **The Bug:** The frontend components (e.g., gaugeCard.js, flowCard.js) often assume numerical values and perform operations like .toFixed(2) or Math.abs(). Passing undefined into these methods throws a fatal error.  
* **Vanilla Fix:** Implement a strict data normalization layer in api.js or updater.js before distributing data to components. Use logical OR fallbacks: const pvPower \= Number(data.pv\_power) || 0;.

## **2\. UI/UX Design & CSS Flaws**

### **A. Non-Responsive SVG Scaling (systemTopology.js & flowCard.js)**

* **The Flaw:** Complex SVGs drawn via vanilla JS or HTML often rely on fixed width and height attributes or rigid viewBox coordinates that assume a desktop or landscape tablet display.  
* **The Bug:** On portrait mobile devices, these SVGs overflow the viewport horizontally, forcing an ugly horizontal scroll or clipping critical data nodes (like the Grid or Battery icons).  
* **Vanilla Fix:** 1\. Remove fixed widths/heights from SVGs.  
  2\. Use CSS: svg { width: 100%; height: auto; max-height: 300px; }.  
  3\. Ensure the viewBox is correctly set to preserve the aspect ratio (preserveAspectRatio="xMidYMid meet").

### **B. Inconsistent Theme Management (theme.js)**

* **The Flaw:** The theme toggling logic likely relies on swapping CSS classes on the \<body\> or loading different stylesheets. If a user transitions between pages (index.html to settings.html), the screen might flash white before the JS executes and applies the dark theme.  
* **Vanilla Fix:** Move the initial theme check to a blocking inline \<script\> in the \<head\> of all HTML files to prevent the Flash of Unstyled Content (FOUC).

## **3\. WCAG 2.2 Accessibility Violations**

Based on the required 60-30-10 color rule and WCAG 2.2 specs, the current vanilla implementation needs the following immediate fixes in style.css and the HTML generators:

1. **Missing aria-live regions:** Real-time data (like current PV output or Battery SOC) updates silently.  
   * *Fix:* Add aria-live="polite" to the metric text containers so screen readers announce changes at appropriate intervals.  
2. **Focus Management:** Modals, dropdowns, and settings tabs heavily rely on onclick events on \<div\> or \<span\> elements which cannot receive keyboard focus.  
   * *Fix:* Convert interactive elements to \<button\>, or add tabindex="0" and listen for the Enter and Space keydown events. Update style.css to include robust focus outlines (e.g., :focus-visible { outline: 2px solid var(--accent-amber); outline-offset: 2px; }).  
3. **Contrast Failures:** Hardcoded gray text (e.g., \#777 or rgba(255,255,255,0.5)) on dark backgrounds often fails the 4.5:1 minimum contrast ratio.  
   * *Fix:* Enforce the Slate color palette. Secondary text should be no darker than \#94A3B8 (Slate 400\) against the \#1E293B (Slate 800\) card backgrounds.

## **4\. Backend / API Flaws (server.js & modules/)**

* **Event Loop Blocking:** If the serial/Modbus parsing in /modules/modbus.js or dongle decoding is done synchronously on large buffers, it can block the Node.js event loop, delaying API responses to the frontend.  
* **Rate Limiting / Backpressure:** If the inverter pushes data rapidly via MQTT, and the frontend connects via SSE, a sudden flood of data can overwhelm the client.  
* **Vanilla Fix:** Implement debouncing/throttling in /modules/metricsManager.js before broadcasting to connected UI clients. Only broadcast state changes, or emit at a fixed tick rate (e.g., 1Hz).

  The poor mobile responsiveness in the current vanilla implementation is a direct result of two main issues: **hardcoded SVG dimensions** in the component files and **inflexible grid containers** in the CSS that fight against mobile viewports.

Here is how we can fix the block sizing and scaling issues across the dashboard while strictly maintaining the vanilla HTML/CSS/JS stack.

### **1\. CSS Fix: Forcing Fluid Grid and Block Resizing on Mobile**

We need to add media queries to public/style.css that override the desktop grid layout (and any inline styles injected by grid libraries) when viewed on mobile screens. This forces blocks to stack vertically and take up 100% of the screen width.

/\* ... existing code ... \*/

/\* \=========================================

  MOBILE RESPONSIVENESS OVERRIDES

  \========================================= \*/

@media (max-width: 768px) {

 /\* Override the main dashboard container to stack items \*/

 .grid-container, .dashboard-grid, \#dashboard {

   display: flex \!important;

   flex-direction: column \!important;

   width: 100% \!important;

   padding: 10px \!important;

 }

 /\* Force all blocks/cards to full width and remove absolute positioning \*/

 .grid-item, .grid-stack-item, .card, .block-container {

   width: 100% \!important;

   min-width: 100% \!important;

   max-width: 100% \!important;

   position: relative \!important;

   top: auto \!important;

   left: auto \!important;

   margin-bottom: 16px \!important;

   transform: none \!important; /\* Disables JS-driven matrix transforms on mobile \*/

 }

 /\* Ensure card contents don't overflow \*/

 .card-content, .block-content {

   overflow: hidden;

   padding: 12px \!important;

 }

}

/\* Universal rule to prevent SVGs from breaking out of their containers \*/

.card svg, .block svg, .grid-item svg {

 max-width: 100% \!important;

 height: auto \!important;

 display: block;

 margin: 0 auto;

}

/\* ... existing code ... \*/

### **2\. SVG Component Fix: Removing Hardcoded Dimensions**

Components like flowCard.js and systemTopology.js likely use hardcoded \<svg width="X" height="Y"\> tags. We must replace these with responsive viewBox attributes so they scale perfectly inside their new fluid CSS containers.  
Here is the pattern you need to apply to flowCard.js (and replicate across any other SVG-based component like gauges):

// ... existing code ...  
   // Note: Ensure we remove fixed width="xxx" height="yyy"  
   // and replace with viewBox and relative widths.  
   const svgHTML \= \`  
     \<svg viewBox="0 0 500 400" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"\>  
// ... existing code ...

### **3\. Ensure Viewport Meta Tag is Present**

Finally, verify that your public/index.html has the correct viewport meta tag in the \<head\>. Without this, mobile browsers will try to render the desktop width and zoom out, ignoring our CSS media queries entirely.

\<\!-- ... existing code ... \--\>  
\<head\>  
 \<meta charset\="UTF-8"\>  
 \<meta name\="viewport" content\="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"\>  
 \<title\>Epilykos Dashboard\</title\>  
\<\!-- ... existing code ... \--\>

**Summary of what this does:**

* The CSS media query intercepts screens smaller than 768px, destroys the absolute/matrix positioning usually applied by vanilla JS grid libraries, and forces a native Flexbox column layout.  
* The viewBox fix ensures that complex SVGs shrink and grow gracefully without clipping off the edges of the screen or forcing a horizontal scrollbar.

# **Epilykos UI/UX Improvement Plan**

**Stack Constraint:** Vanilla HTML / CSS / JS

To transform Epilykos from a functional monitoring tool into a polished, professional-grade energy dashboard, we need to address visual hierarchy, typography, animation smoothness, and strict accessibility standards.

## **1\. The 60-30-10 Color System Implementation**

Currently, the components likely use fragmented, hardcoded colors. We need to centralize this in style.css using CSS Variables to enforce the 60-30-10 rule for both Light and Dark themes.

### **Dark Theme Palette (Default for Dashboards)**

* **60% Primary (Backgrounds):** Deep Slate (\#0F172A) \- Reduces eye strain for always-on displays.  
* **30% Secondary (Surfaces/Cards):** Elevated Slate (\#1E293B) with a subtle \#334155 border to separate modular blocks without heavy drop shadows.  
* **10% Accents (Data & Actions):**  
  * **Solar/PV:** Amber (\#F59E0B)  
  * **Battery/Eco:** Emerald (\#10B981)  
  * **Grid/Utility:** Blue (\#3B82F6)  
  * **Alerts/High Load:** Rose (\#F43F5E)

**CSS Implementation Strategy:**

Define these globally in the :root pseudo-class in style.css and map all component JS files to use var(--color-pv), etc., instead of hardcoded hex codes in canvas/SVG drawing functions.

## **2\. Typography & "Data Jitter" Prevention**

Real-time dashboards suffer from "data jitter"—where numbers rapidly changing (e.g., 3.14 kW to 10.50 kW) cause the layout to bounce horizontally because characters have different widths.

* **UX Fix:** Apply font-variant-numeric: tabular-nums; to all data value containers. This forces numbers to have identical widths (like a monospace font) while keeping the elegant sans-serif look.  
* **Hierarchy:** Use a heavy weight (700-800) for primary metrics, and a lighter weight (400) for units (kW, V, A) to make the numbers scan faster.

## **3\. Information Architecture (IA) & Layout Flow**

The modular grid is great, but users read top-to-bottom, left-to-right. Establish a default grid layout that tells a story:

1. **The "Now" (Top Row):** Live Power Flow (systemTopology.js or flowCard.js). The user needs to instantly know: *Is power going into the battery or out to the grid?*  
2. **The "Core Metrics" (Middle Row):** Battery SOC (State of Charge) prominently displayed, next to today's total PV generation.  
3. **The "Context" (Bottom Row/Full Width):** Historical charts (chartEnergy.js) and weather forecasts to contextualize *why* the system is behaving as it is.

## **4\. Animation & Interaction Design**

Vanilla JS manipulating DOM elements rapidly can look jerky. We should offload animations to the GPU via CSS.

* **Flow Card Animations:** Instead of redrawing SVG lines via JS to simulate power flow, use CSS stroke-dasharray and stroke-dashoffset animations. JS only needs to change a CSS variable \--flow-speed based on the wattage.  
* **Hover States:** Add subtle transform: translateY(-2px) and box-shadow changes on hover for interactive cards (like settings or chart toggles) to make the dashboard feel tactile.

## **5\. WCAG 2.2 Accessibility Hardening**

As an energy tool, it must be usable in bright sunlight (high contrast) and accessible to all users.

* **Target Size (2.5.8):** Update style.css so any clickable element inside settings.html, login.html, or the dashboard has a minimum touch target of 44px by 44px. Add padding to small icons to achieve this without making the icon itself massive.  
* **Focus Not Obscured (2.4.11):** Ensure that when tabbing through the dashboard, the focused card isn't hidden behind sticky headers. Add :focus-visible { outline: 3px solid var(--accent-solar); outline-offset: 4px; border-radius: 8px; }.  
* **Dynamic ARIA:** In updater.js, when a critical state changes (e.g., Grid Outage detected), inject text into a visually hidden div with aria-live="assertive". For normal metric updates, use aria-live="polite" so screen readers can announce the new battery percentage without interrupting the user.

## **Actionable Next Steps for the Vanilla Codebase:**

1. **Refactor style.css**: Inject the CSS variable system and tabular-nums.  
2. **Update Component SVGs**: Strip hardcoded colors from flowCard.js, gaugeCard.js, etc., and replace them with var(--accent-color) so themes apply instantly without JS redraws.  
3. **Optimize charts.js**: Implement Chart.js (or equivalent library) .update() methods instead of .destroy() and .render() to make chart transitions fluid rather than flashing.

I will update the two most critical visual components: flowCard.js (the main power routing diagram) and gaugeCard.js (the standard dial meters).

Since these files currently hardcode their SVG dimensions and colors, I am refactoring them to use the fluid viewBox attribute and the new CSS color variables we just defined. This ensures they will stretch and shrink perfectly on mobile screens without breaking their aspect ratio.  
Here are the updated vanilla JS files:

Refactored Flow Card

/\*\*

\* Refactored FlowCard Component

\* \- Removed hardcoded width/height (e.g. width="800" height="400")

\* \- Implemented responsive viewBox="0 0 800 400"

\* \- Replaced hardcoded hex colors with CSS variables for seamless theme switching

\*/

class FlowCard {

   constructor(containerId, config) {

       this.container \= document.getElementById(containerId);

       this.config \= config || {};

       this.init();

   }

   init() {

       if (\!this.container) return;

      

       // Use 100% width/height and a viewBox to ensure fluid scaling on mobile

       const svgContent \= \`

           \<div class="block-content"\>

               \<svg viewBox="0 0 800 400" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"\>

                   \<\!-- Central Hub (Home) \--\>

                   \<circle cx="400" cy="200" r="40" fill="var(--bg-secondary)" stroke="var(--border-color)" stroke-width="4"/\>

                   \<text x="400" y="205" text-anchor="middle" fill="var(--text-primary)" font-size="16" font-weight="bold" id="flow-home-load"\>0 kW\</text\>

                   \<text x="400" y="225" text-anchor="middle" fill="var(--text-secondary)" font-size="12"\>Home\</text\>

                   \<\!-- Solar Node (Top) \--\>

                   \<circle cx="400" cy="50" r="35" fill="var(--bg-secondary)" stroke="var(--accent-solar)" stroke-width="3"/\>

                   \<text x="400" y="55" text-anchor="middle" fill="var(--accent-solar)" font-size="14" font-weight="bold" id="flow-pv-power"\>0 kW\</text\>

                   \<\!-- Solar Line \--\>

                   \<line x1="400" y1="85" x2="400" y2="160" stroke="var(--accent-solar)" stroke-width="4" stroke-dasharray="8 4" id="line-pv-home"/\>

                   \<\!-- Grid Node (Left) \--\>

                   \<circle cx="150" cy="200" r="35" fill="var(--bg-secondary)" stroke="var(--accent-grid)" stroke-width="3"/\>

                   \<text x="150" y="205" text-anchor="middle" fill="var(--accent-grid)" font-size="14" font-weight="bold" id="flow-grid-power"\>0 kW\</text\>

                   \<\!-- Grid Line \--\>

                   \<line x1="185" y1="200" x2="360" y2="200" stroke="var(--accent-grid)" stroke-width="4" stroke-dasharray="8 4" id="line-grid-home"/\>

                   \<\!-- Battery Node (Right) \--\>

                   \<circle cx="650" cy="200" r="35" fill="var(--bg-secondary)" stroke="var(--accent-battery)" stroke-width="3"/\>

                   \<text x="650" y="205" text-anchor="middle" fill="var(--accent-battery)" font-size="14" font-weight="bold" id="flow-batt-power"\>0 kW\</text\>

                   \<\!-- Battery Line \--\>

                   \<line x1="440" y1="200" x2="615" y2="200" stroke="var(--accent-battery)" stroke-width="4" stroke-dasharray="8 4" id="line-batt-home"/\>

               \</svg\>

           \</div\>

       \`;

      

       this.container.innerHTML \= svgContent;

       this.bindElements();

   }

   bindElements() {

       this.els \= {

           home: this.container.querySelector('\#flow-home-load'),

           pv: this.container.querySelector('\#flow-pv-power'),

           grid: this.container.querySelector('\#flow-grid-power'),

           batt: this.container.querySelector('\#flow-batt-power'),

           linePv: this.container.querySelector('\#line-pv-home'),

           lineGrid: this.container.querySelector('\#line-grid-home'),

           lineBatt: this.container.querySelector('\#line-batt-home')

       };

   }

   update(data) {

       if (\!data || \!this.els.home) return; // Graceful failure

       // Update Text Values safely

       if (data.load\_power \!== undefined) this.els.home.textContent \= \`${data.load\_power.toFixed(2)} kW\`;

       if (data.pv\_power \!== undefined) this.els.pv.textContent \= \`${data.pv\_power.toFixed(2)} kW\`;

       if (data.grid\_power \!== undefined) this.els.grid.textContent \= \`${data.grid\_power.toFixed(2)} kW\`;

       if (data.battery\_power \!== undefined) this.els.batt.textContent \= \`${data.battery\_power.toFixed(2)} kW\`;

       // Animate lines using CSS offset based on power direction

       this.animateLine(this.els.linePv, data.pv\_power, false);

       this.animateLine(this.els.lineGrid, data.grid\_power, data.grid\_power \< 0); // Negative \= Export

       this.animateLine(this.els.lineBatt, data.battery\_power, data.battery\_power \< 0); // Negative \= Charging

   }

   animateLine(element, power, reverse) {

       if (\!element) return;

       const speed \= Math.max(0.5, 5 \- Math.abs(power || 0)); // Calculate animation speed

       if (Math.abs(power) \< 0.05) {

           element.style.animation \= 'none'; // Stop if no flow

       } else {

           const dir \= reverse ? 'reverse' : 'normal';

           element.style.animation \= \`dash ${speed}s linear infinite ${dir}\`;

       }

   }

}

// Ensure the animation keyframes exist in the document

if (\!document.getElementById('flow-card-styles')) {

   const style \= document.createElement('style');

   style.id \= 'flow-card-styles';

   style.innerHTML \= \`@keyframes dash { to { stroke-dashoffset: \-24; } }\`;

   document.head.appendChild(style);

}

export default FlowCard;

Refactored Gauge Card

/\*\*

\* Refactored GaugeCard Component

\* \- Fixed memory leak by avoiding continuous SVG redraws

\* \- Uses fluid viewBox scaling for mobile

\*/

class GaugeCard {

   constructor(containerId, config) {

       this.container \= document.getElementById(containerId);

       this.config \= {

           title: config.title || 'Metric',

           min: config.min || 0,

           max: config.max || 100,

           unit: config.unit || '%',

           accent: config.accent || 'var(--accent-solar)',

           ...config

       };

       this.init();

   }

   init() {

       if (\!this.container) return;

       // Using viewBox="0 0 200 200" allows the gauge to shrink/grow infinitely

       const svgContent \= \`

           \<div class="block-content flex-col-center"\>

               \<h3 style="color: var(--text-secondary); font-size: 14px; margin-bottom: 8px;"\>${this.config.title}\</h3\>

               \<svg viewBox="0 0 200 200" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"\>

                   \<\!-- Background Arc \--\>

                   \<path d="M 40 160 A 80 80 0 1 1 160 160" fill="none" stroke="var(--border-color)" stroke-width="15" stroke-linecap="round"/\>

                  

                   \<\!-- Value Arc (Foreground) \--\>

                   \<path id="gauge-arc-${this.container.id}" d="M 40 160 A 80 80 0 1 1 160 160" fill="none" stroke="${this.config.accent}" stroke-width="15" stroke-linecap="round" stroke-dasharray="377" stroke-dashoffset="377" style="transition: stroke-dashoffset 0.5s ease-in-out;"/\>

                  

                   \<\!-- Value Text \--\>

                   \<text x="100" y="110" text-anchor="middle" fill="var(--text-primary)" font-size="28" font-weight="bold" id="gauge-val-${this.container.id}"\>0\</text\>

                   \<text x="100" y="135" text-anchor="middle" fill="var(--text-secondary)" font-size="14"\>${this.config.unit}\</text\>

               \</svg\>

           \</div\>

       \`;

      

       this.container.innerHTML \= svgContent;

       this.arcEl \= this.container.querySelector(\`\#gauge-arc-${this.container.id}\`);

       this.valEl \= this.container.querySelector(\`\#gauge-val-${this.container.id}\`);

   }

   update(value) {

       if (\!this.arcEl || \!this.valEl || value \=== undefined) return;

       // Clamp value between min and max

       const safeValue \= Math.max(this.config.min, Math.min(this.config.max, value));

      

       // Calculate percentage (0 to 1\)

       const percent \= (safeValue \- this.config.min) / (this.config.max \- this.config.min);

      

       // Max arc length is roughly 377 for this radius/path

       const dashOffset \= 377 \- (377 \* percent);

       // Update DOM (CSS transition handles the smooth animation)

       this.arcEl.style.strokeDashoffset \= dashOffset;

      

       // Update Text (use tabular-nums formatting)

       this.valEl.textContent \= Number.isInteger(safeValue) ? safeValue : safeValue.toFixed(1);

   }

}

export default GaugeCard;

### **What these changes achieve:**

1. **Responsiveness:** Notice how \<svg viewBox="0 0 800 400" width="100%" height="100%"\> replaced explicit pixel widths. Now, when the CSS Media Query we added earlier kicks in on a mobile phone, this SVG will smoothly shrink to fit the screen without causing a horizontal scrollbar.  
2. **Smooth GPU Animation:** Instead of using JavaScript intervals to redraw the line dashes to simulate power flowing, I moved the logic to pure CSS (stroke-dashoffset and @keyframes). This is vastly lighter on the CPU and prevents battery drain on mobile devices.  
3. **Theming:** Colors like \#FF9900 are replaced with var(--accent-solar).

You can apply these exact same patterns (viewBox \+ var(--colors) \+ CSS transitions) to systemTopology.js and halfGaugeCard.js to complete the mobile UI overhaul\!

I have reviewed the architecture of the refactored GaugeCard in the Canvas. To bring the rest of the dashboard components up to this standard, we need to apply four core principles across the board: **Fluid SVG Scaling (**viewBox**)**, **CSS Variable Theming**, **DOM Reference Caching (Anti-Thrashing)**, and **GPU-Accelerated Transitions**.

Here is a comprehensive refactoring guide for the other critical components in your project.

# **Component Refactoring Guide**

Based on the GaugeCard improvements, the following vanilla JS components require structural updates to prevent memory leaks, ensure mobile responsiveness, and support the 60-30-10 color system.

## **1\. Half Gauge Cards (halfGaugeCard.js & halfGauge2Card.js)**

These cards suffer from the exact same issues as the original GaugeCard: hardcoded dimensions and manual DOM overwriting.

**Improvements to apply:**

* **Fluid scaling:** Replace \<svg width="250" height="150"\> with \<svg viewBox="0 0 250 150" width="100%" height="100%"\>.  
* **Smooth CSS Animation:** The half-gauge path will have a different stroke-dasharray (e.g., 125 instead of 377). Apply style="transition: stroke-dashoffset 0.5s ease;" to the SVG path in init(), and only update the dashOffset property in update().  
* **DOM Caching:** \`\`\`javascript  
  // BAD (Current pattern in some cards):  
  update(val) { this.container.innerHTML \= \<svg\>...${val}...\</svg\>; }  
  // GOOD (Refactored pattern):  
  init() {  
  this.container.innerHTML \= \<svg\>...\<text id="val-${this.id}"\>\</text\>\</svg\>;  
  this.valNode \= document.getElementById(val-${this.id});  
  }  
  update(val) { this.valNode.textContent \= val; }

## **2\. System Topology Card (systemTopology.js)**

This is likely the most complex visual component and the biggest culprit for breaking mobile layouts.

**Improvements to apply:**

* **The ViewBox Fix:** This SVG absolutely must use viewBox="0 0 1000 600" (or whatever its native aspect ratio is) and preserveAspectRatio="xMidYMid meet".  
* **Theme Variables:** Replace all instances of fill="\#333" or stroke="blue" with fill="var(--bg-secondary)" and stroke="var(--accent-grid)". This allows the topology to instantly switch to light mode if you ever implement it, without requiring a JS redraw.  
* **CSS Keyframe Flow Animation:** Just like in flowCard.js, do not use JavaScript requestAnimationFrame or setInterval to move dots along the lines. Instead, use a dashed line and animate the stroke-dashoffset infinitely via CSS. Use JavaScript *only* to change the animation duration based on power intensity:  
  // In update(data):  
  const intensity \= Math.abs(data.gridPower);  
  const speed \= intensity \> 0 ? Math.max(0.2, 3 \- (intensity / 1000)) : 0;  
  this.gridLine.style.animation \= speed \> 0 ? \\\`dash \\${speed}s linear infinite\\\` : 'none';

## **3\. Battery Block (batteryBlock.js)**

The battery block needs to visually represent the State of Charge (SOC) while remaining responsive.

**Improvements to apply:**

* **Dynamic CSS Variables for Status:** Instead of writing complex JS logic to change the battery fill color from green to orange to red, calculate it once and apply it as an inline CSS variable.  
  // In update(data):  
  let color \= 'var(--accent-battery)'; // Default Emerald  
  if (data.soc \<= 20\) color \= 'var(--accent-alert)'; // Rose  
  else if (data.soc \<= 50\) color \= 'var(--accent-solar)'; // Amber

  this.batteryFillNode.style.backgroundColor \= color;  
  this.batteryFillNode.style.width \= \\\`\\${data.soc}%\\\`; // Fluid width

## **4\. Text & Metric Cards (textCard.js, metricCards.js, pvToday.js)**

These cards are text-heavy and suffer from "Data Jitter" (the layout bouncing as numbers tick up and down).

**Improvements to apply:**

* **Tabular Nums:** Ensure the container applying the text has font-variant-numeric: tabular-nums;. This is critical for real-time dashboards.  
* **Safe HTML Injection:** If these cards currently use innerHTML to update data strings, they are vulnerable to XSS if data is ever pulled from an external unsanitized source. Use .textContent for updating purely numerical/text values.  
* **Null Handling:** Many of these cards will crash the app if data.today\_yield is undefined. Wrap the update logic in a safety check:  
  update(value) {  
      // Fallback to '--' or '0' if data is missing, preventing a UI crash  
      const displayValue \= (value \!== undefined && value \!== null) ? Number(value).toFixed(2) : '--';  
      this.valueNode.textContent \= displayValue;  
  }

## **5\. Charts (chartEnergy.js, chartPower.js)**

If you are using Chart.js or ECharts:

* **Destroy vs. Update:** Never call new Chart() inside the update() loop. This causes massive WebGL memory leaks. Always initialize the chart in init(). In update(data), mutate this.chart.data.datasets\[0\].data and call this.chart.update('none') (using 'none' prevents the jarring start-up animation from replaying on every tick).

By systematically applying the .init() DOM-creation / .update() DOM-mutation split, swapping fixed pixels for viewBox, and enforcing CSS variable colors, your dashboard will become remarkably stable, fluid on all device sizes, and highly performant.  
Would you like me to provide the specific refactored code for halfGaugeCard.js or systemTopology.js next?

