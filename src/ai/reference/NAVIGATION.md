# Posnic navigation reference

This file lists real screens, menu paths and controls. Use these labels
exactly. If a screen is not listed here, do not invent its controls.

## Main menu

The left sidebar groups pages under these headings:

- **Home**: Dashboard, New Sale, Sales History.
- **Purchase**: Purchases, Supplier List.
- **Inventory**: Items, Price Settings, Categories, Expiry list, Stock Counts.
- **Customers**: Customer List, Customer Category, Catalog Display.
- **Reports**: Sales, Purchase, Inventory, People, Money.
- **Manage**: Core Settings, Branches / Outlet, Employees, Features,
  Extensions, AI Assistant, Cash Register, Workforce, Themes, Recycle Bin,
  Till PIN Lock, Devices & Printing, App Settings, Software Updates,
  Backup & Recovery, System Status.

Some entries are hidden when the signed-in user lacks the matching permission
or when the feature is off.

## Add a product

1. Open **Inventory → Items** (`#/items`). The page title is **Item List**.
2. At the top right, open the **New** dropdown.
3. Choose **Standard item** (`#/items/new`).

The item form is split into sections: **Basics**, **Stock & pricing**,
**Photos & details**, **Languages**, and **Codes & variants**. The same form
also has **Back to items** at the top.

Do not say there is an "Add Item" button. The visible control is **New**, and
the menu item is **Standard item**.

## Edit a product

1. Open **Inventory → Items**.
2. Search or filter the list, then open the product row.
3. Change the fields and save with the form's save button.

The assistant can prepare an edit preview for an existing product. The user
must press **Confirm** before the main process saves it.

## Stock adjustment

1. Open **Inventory → Items**.
2. At the top right, open the **Tools** dropdown.
3. Choose **Stock adjustment**.

The same **Tools** dropdown contains, in this order: **Product availability**,
**Print shelf / product labels**, **Item settings**, **Copy catalogue to other
branches** (only when the shop has more than one branch), **Bulk price
update**, **Stock adjustment** and **Bulk stock update**.

The **New** dropdown contains **Standard item** and **Bulk add**. The page
header also has **Import**, **Export**, **Tools**, **Filter** and **New**.

The assistant can prepare a stock-adjustment preview for one existing product.
The user must press **Confirm** before the audited stock log is written.

## Price Settings

Open **Inventory → Price Settings** (`#/pricesettings`).

## Categories

Open **Inventory → Categories** (`#/categories`). The page title is
**Categories**.

## Add a category

1. Open **Inventory → Categories**.
2. At the top right, click the **New** button. Its tooltip is **New category**.
3. The new-category form opens at `#/categories/new`.

The assistant can prepare a new-category preview. The user must press
**Confirm** before the main process saves it.

## Stock Counts

Open **Inventory → Stock Counts** (`#/inventorycounts`). This is the count
worksheet and stock audit page. It is not the same as **Stock adjustment**.

## Expiry list

Open **Inventory → Expiry list** (`#/expiryreport`).

## New Sale

Open **Home → New Sale** (`#/sales/new`). This is the till screen.

## Sales History

Open **Home → Sales History** (`#/sales`).

## Purchases

Open **Purchase → Purchases** (`#/purchaseorders`).

## Supplier List

Open **Purchase → Supplier List** (`#/suppliers`).

## Customer List

Open **Customers → Customer List** (`#/customers`).

## Customer Category

Open **Customers → Customer Category** (`#/customercategory`).

## Catalog Display

Open **Customers → Catalog Display**. This opens the customer-facing
catalogue in a new window (`customersearch.html`).

## Reports

Open **Reports**, then choose one of:

- **Sales** (`#/quickreport`)
- **Purchase** (`#/receivingreport`)
- **Inventory** (`#/itemreport`)
- **People** (`#/customerreport`)
- **Money** (`#/paymentreport`)

## AI Assistant

Open **Manage → AI Assistant** (`#/ai`). The page title is **AI Assistant**.

This is where the shop turns the assistant on, saves the Groq Whisper key and
the model provider token, chooses the provider and model, and opens the
conversation. The assistant cannot open this page by itself; the user does.

## Manage settings

Open **Manage**, then choose:

- **Core Settings** (`#/settings/general`)
- **Branches / Outlet** (`#/branches`)
- **Employees** (`#/users`)
- **Features** (`#/settings/modules`)
- **Extensions** (`#/extensions`)
- **AI Assistant** (`#/ai`)
- **Cash Register** (`#/settings/cashregister`)
- **Workforce** (`#/settings/workforce`)
- **Themes** (`#/settings/theme`)
- **Recycle Bin** (`#/settings/recyclebin`)
- **Till PIN Lock** (`#/settings/tillpin`)
- **Devices & Printing** (`#/settings/hardware`)
- **App Settings** (`#/settings/app`)
- **Software Updates** (`#/settings/updates`)
- **Backup & Recovery** (`#/settings/backups`)
- **System Status** (`#/settings/systemstatus`)

Some Manage entries only appear in the desktop app. They are marked as
desktop-only in the sidebar.

## Universal search

The header search opens the command palette. It can find pages and, where the
user has permission, records such as products and customers. It is not the
same as the assistant. Use the assistant for questions and the command palette
for jumping to a page.

## What not to say

- Do not say "Settings" for **Manage**; the sidebar heading is **Manage**.
- Do not say "Products" for the page; the sidebar label is **Items** and the
  page title is **Item List**.
- Do not say "Add Item" for the control; it is **New → Standard item**.
- Do not say "Add Category" for the control; it is **New**, with the tooltip
  **New category**.
- Do not say a control is on the left when it is in the top-right header.
- Do not mention a route the user cannot open because of permissions.
