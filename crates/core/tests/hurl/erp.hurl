# API-only ERP pricing integration scenario. The bundle is submitted as JSON to the admin import API;
# all records and many-to-many rows are then created/read over HTTP.
GET {{base}}/api/auth/v1/status
Authorization: Bearer {{auth_token}}
HTTP 200
[Captures]
csrf_token: jsonpath "$.csrf_token"

POST {{base}}/api/_admin/content-types/import
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
file,erp.json;
HTTP 200
[Asserts]
jsonpath "$.data" count == 21

# UOM and packaging fixtures.
POST {{base}}/api/records/v1/uom_categories
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"name":"Count"}
HTTP 200
[Captures]
uom_category: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/units_of_measure
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"uom_category":{{uom_category}},"code":"each","name":"Each","kind":"reference","factor":1}
HTTP 200
[Captures]
each_uom: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/units_of_measure
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"uom_category":{{uom_category}},"code":"box","name":"Box of 20","kind":"bigger","factor":20}
HTTP 200
[Captures]
box_uom: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/units_of_measure
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"uom_category":{{uom_category}},"code":"pallet","name":"Pallet of 77 boxes","kind":"bigger","factor":1540}
HTTP 200
[Captures]
pallet_uom: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/packagings
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"code":"each","name":"Each","units":1}
HTTP 200
[Captures]
each_pack: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/packagings
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"code":"box","name":"Box of 20","units":20}
HTTP 200
[Captures]
box_pack: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/packagings
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"code":"pallet","name":"Pallet of 77 boxes","units":1540}
HTTP 200
[Captures]
pallet_pack: jsonpath "$.ids[0]"

# Products. The base unit price is 2.50 EUR; product B covers a second VAT rate.
POST {{base}}/api/records/v1/products
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"name":"Product A","sku":"ERP-A","kind":"product","status":"active","list_price":2.5,"list_price_uom":{{each_uom}},"sale_price":2.5,"default_discount_percent":5,"vat_rate":20,"uom_category":{{uom_category}},"stock_uom":{{each_uom}}}
HTTP 200
[Captures]
product_a: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/products
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"name":"Product B","sku":"ERP-B","kind":"product","status":"active","list_price":10,"list_price_uom":{{each_uom}},"sale_price":10,"default_discount_percent":0,"vat_rate":10,"uom_category":{{uom_category}},"stock_uom":{{each_uom}}}
HTTP 200
[Captures]
product_b: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__product_product_rel_packaging
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{product_a}}},"target_id":{"Integer":{{each_pack}}}}}
HTTP 200

POST {{base}}/api/_admin/table/ct_api__product_product_rel_packaging
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{product_a}}},"target_id":{"Integer":{{box_pack}}}}}
HTTP 200

POST {{base}}/api/_admin/table/ct_api__product_product_rel_packaging
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{product_a}}},"target_id":{"Integer":{{pallet_pack}}}}}
HTTP 200

# A group price list offers 44 EUR per box. A customer price list offers 3080 EUR per pallet.
POST {{base}}/api/records/v1/price_lists
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"name":"Wholesale EUR","currency":"EUR","is_active":true,"priority":10}
HTTP 200
[Captures]
group_list: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/price_lists
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"name":"Customer EUR","currency":"EUR","is_active":true,"priority":10}
HTTP 200
[Captures]
customer_list: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__price_list_price_list_rel_items
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{group_list}}},"target_id":{"Integer":{{product_a}}},"uom":{"Integer":{{box_uom}}},"minimum_quantity":{"Real":1},"unit_price":{"Real":44}}}
HTTP 200

POST {{base}}/api/_admin/table/ct_api__price_list_price_list_rel_items
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{customer_list}}},"target_id":{"Integer":{{product_a}}},"uom":{"Integer":{{pallet_uom}}},"minimum_quantity":{"Real":1},"unit_price":{"Real":3080}}}
HTTP 200

POST {{base}}/api/records/v1/customer_groups
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"code":"WHOLESALE","name":"Wholesale","active":true}
HTTP 200
[Captures]
group_id: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__customer_group_customer_group_rel_price_lists
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{group_id}}},"target_id":{"Integer":{{group_list}}}}}
HTTP 200

POST {{base}}/api/records/v1/organizations
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"legal_name":"Group buyer","status":"customer","customer_group":{{group_id}},"global_discount_percent":null}
HTTP 200
[Captures]
group_customer: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/organizations
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"legal_name":"Customer list buyer","status":"customer","global_discount_percent":0}
HTTP 200
[Captures]
list_customer: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__organization_organization_rel_price_lists
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{list_customer}}},"target_id":{"Integer":{{customer_list}}}}}
HTTP 200

POST {{base}}/api/records/v1/organizations
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"legal_name":"Specific discount buyer","status":"customer","global_discount_percent":null}
HTTP 200
[Captures]
specific_customer: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/organizations
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"legal_name":"Global discount buyer","status":"customer","global_discount_percent":12}
HTTP 200
[Captures]
global_customer: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/organizations
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"legal_name":"Product default buyer","status":"customer","global_discount_percent":null}
HTTP 200
[Captures]
default_customer: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/organizations
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"legal_name":"Fixed discount buyer","status":"customer","global_discount_percent":null}
HTTP 200
[Captures]
fixed_customer: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/organizations
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"legal_name":"No discount buyer","status":"customer","global_discount_percent":0}
HTTP 200
[Captures]
zero_customer: jsonpath "$.ids[0]"

POST {{base}}/api/records/v1/customer_price_rules
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"product":{{product_a}},"customer_group":{{group_id}},"price_type":"discount_percent","value":10,"currency":"EUR","active":true,"priority":1}
HTTP 200

POST {{base}}/api/records/v1/customer_price_rules
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"product":{{product_a}},"customer":{{group_customer}},"price_type":"discount_percent","value":25,"currency":"EUR","active":true,"priority":10}
HTTP 200

POST {{base}}/api/records/v1/customer_price_rules
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"product":{{product_a}},"customer":{{specific_customer}},"price_type":"discount_percent","value":15,"currency":"EUR","active":true}
HTTP 200

POST {{base}}/api/records/v1/customer_price_rules
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"product":{{product_a}},"customer":{{fixed_customer}},"price_type":"discount_amount","value":5,"currency":"EUR","active":true}
HTTP 200

# Create one invoice per pricing scenario, add its M2M line through the admin table API,
# then read the stored invoice totals through the public records API.
POST {{base}}/api/records/v1/sales_invoices
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"document_number":"HURL-GROUP","status":"draft","customer":{{group_customer}},"currency":"EUR"}
HTTP 200
[Captures]
group_invoice: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__sales_invoice_sales_invoice_rel_lines
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{group_invoice}}},"target_id":{"Integer":{{product_a}}},"packaging":{"Integer":{{box_pack}}},"quantity":{"Real":2}}}
HTTP 200

GET {{base}}/api/records/v1/sales_invoices/{{group_invoice}}
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
HTTP 200
[Asserts]
jsonpath "$.pre_discount_amount" == 88
jsonpath "$.discount_amount" == 8.8
jsonpath "$.vat_amount" == 15.84
jsonpath "$.total_amount" == 95.04

POST {{base}}/api/records/v1/sales_invoices
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"document_number":"HURL-CUSTOMER-LIST","status":"draft","customer":{{list_customer}},"currency":"EUR"}
HTTP 200
[Captures]
list_invoice: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__sales_invoice_sales_invoice_rel_lines
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{list_invoice}}},"target_id":{"Integer":{{product_a}}},"packaging":{"Integer":{{pallet_pack}}},"quantity":{"Real":1}}}
HTTP 200

GET {{base}}/api/records/v1/sales_invoices/{{list_invoice}}
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
HTTP 200
[Asserts]
jsonpath "$.pre_discount_amount" == 3080
jsonpath "$.vat_amount" == 616
jsonpath "$.total_amount" == 3696

POST {{base}}/api/records/v1/sales_invoices
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"document_number":"HURL-SPECIFIC","status":"draft","customer":{{specific_customer}},"currency":"EUR"}
HTTP 200
[Captures]
specific_invoice: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__sales_invoice_sales_invoice_rel_lines
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{specific_invoice}}},"target_id":{"Integer":{{product_a}}},"packaging":{"Integer":{{box_pack}}},"quantity":{"Real":1}}}
HTTP 200

GET {{base}}/api/records/v1/sales_invoices/{{specific_invoice}}
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
HTTP 200
[Asserts]
jsonpath "$.pre_discount_amount" == 50
jsonpath "$.discount_amount" == 7.5
jsonpath "$.vat_amount" == 8.5
jsonpath "$.total_amount" == 51

POST {{base}}/api/records/v1/sales_invoices
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"document_number":"HURL-GLOBAL","status":"draft","customer":{{global_customer}},"currency":"EUR"}
HTTP 200
[Captures]
global_invoice: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__sales_invoice_sales_invoice_rel_lines
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{global_invoice}}},"target_id":{"Integer":{{product_a}}},"packaging":{"Integer":{{box_pack}}},"quantity":{"Real":1}}}
HTTP 200

GET {{base}}/api/records/v1/sales_invoices/{{global_invoice}}
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
HTTP 200
[Asserts]
jsonpath "$.discount_amount" == 6
jsonpath "$.total_amount" == 52.8

POST {{base}}/api/records/v1/sales_invoices
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"document_number":"HURL-DEFAULT","status":"draft","customer":{{default_customer}},"currency":"EUR"}
HTTP 200
[Captures]
default_invoice: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__sales_invoice_sales_invoice_rel_lines
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{default_invoice}}},"target_id":{"Integer":{{product_a}}},"packaging":{"Integer":{{box_pack}}},"quantity":{"Real":1}}}
HTTP 200

GET {{base}}/api/records/v1/sales_invoices/{{default_invoice}}
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
HTTP 200
[Asserts]
jsonpath "$.discount_amount" == 2.5
jsonpath "$.total_amount" == 57

POST {{base}}/api/records/v1/sales_invoices
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"document_number":"HURL-FIXED","status":"draft","customer":{{fixed_customer}},"currency":"EUR"}
HTTP 200
[Captures]
fixed_invoice: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__sales_invoice_sales_invoice_rel_lines
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{fixed_invoice}}},"target_id":{"Integer":{{product_a}}},"packaging":{"Integer":{{box_pack}}},"quantity":{"Real":1}}}
HTTP 200

GET {{base}}/api/records/v1/sales_invoices/{{fixed_invoice}}
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
HTTP 200
[Asserts]
jsonpath "$.discount_amount" == 5
jsonpath "$.total_amount" == 54

# Explicit line values override generated defaults.
POST {{base}}/api/records/v1/sales_invoices
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"document_number":"HURL-OVERRIDE","status":"draft","customer":{{default_customer}},"currency":"EUR"}
HTTP 200
[Captures]
override_invoice: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__sales_invoice_sales_invoice_rel_lines
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{override_invoice}}},"target_id":{"Integer":{{product_a}}},"packaging":{"Integer":{{each_pack}}},"quantity":{"Real":2},"unit_price":{"Real":3},"discount_rate":{"Real":2}}}
HTTP 200

GET {{base}}/api/records/v1/sales_invoices/{{override_invoice}}
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
HTTP 200
[Asserts]
jsonpath "$.pre_discount_amount" == 6
jsonpath "$.discount_amount" == 0.12
jsonpath "$.vat_amount" == 1.18
jsonpath "$.total_amount" == 7.06

# Invoice totals aggregate each line's VAT and include charges/tax before withholding.
POST {{base}}/api/records/v1/sales_invoices
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"document_number":"HURL-MULTI","status":"draft","customer":{{zero_customer}},"currency":"EUR","charges_amount":3.5,"tax_amount":1,"withholding_amount":2}
HTTP 200
[Captures]
multi_invoice: jsonpath "$.ids[0]"

POST {{base}}/api/_admin/table/ct_api__sales_invoice_sales_invoice_rel_lines
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{multi_invoice}}},"target_id":{"Integer":{{product_a}}},"packaging":{"Integer":{{each_pack}}},"quantity":{"Real":3}}}
HTTP 200

POST {{base}}/api/_admin/table/ct_api__sales_invoice_sales_invoice_rel_lines
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
Content-Type: application/json
{"row":{"source_id":{"Integer":{{multi_invoice}}},"target_id":{"Integer":{{product_b}}},"packaging":{"Integer":{{each_pack}}},"quantity":{"Real":1}}}
HTTP 200

GET {{base}}/api/records/v1/sales_invoices/{{multi_invoice}}
Authorization: Bearer {{auth_token}}
CSRF-Token: {{csrf_token}}
HTTP 200
[Asserts]
jsonpath "$.pre_discount_amount" == 17.5
jsonpath "$.discount_amount" == 0
jsonpath "$.vat_amount" == 2.5
jsonpath "$.total_amount" == 24.5
jsonpath "$.payable_amount" == 22.5
