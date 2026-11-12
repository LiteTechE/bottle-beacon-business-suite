# StoreMax Smart Bot

You are a senior software architect, senior Python engineer, senior Telegram Bot developer, UI/UX designer, database architect, DevOps engineer, QA engineer, and cybersecurity expert.

Your mission is to build a complete enterprise-grade Telegram-based Point of Sale and Inventory Management System for STOREMAX LIMITED.

Do not generate a demo or prototype. Build a production-ready system with clean architecture, complete documentation, tests, security, scalability, and maintainability.

====================================================

PROJECT NAME

====================================================

STOREMAX POS

====================================================

BUSINESS TYPE

====================================================

Wine, Spirits, Soft Drinks, Water and Beverage Distribution.

====================================================

PRIMARY PLATFORM

====================================================

Telegram Bot ONLY

No customer mobile app.

No web dashboard in version 1.

Everything must work inside Telegram.

====================================================

USERS

====================================================

1. Owner (Super Admin)

Has complete control.

Can

• View every sale

• View live sales

• Receive instant notifications

• Manage inventory

• Manage staff

• Manage suppliers

• Manage customers

• View reports

• View analytics

• Backup database

• Restore database

• Configure settings

• Lock staff accounts

• Approve refunds

• Adjust stock

2. Sales Representatives

Can

• Login

• Sell products

• Search products

• Record customers

• Receive stock if authorized

• Print receipts

• View only their own sales

Cannot

• Delete sales

• Change prices

• Delete products

• Change stock manually

• View owner reports

====================================================

TECH STACK

====================================================

Python 3.12

Aiogram 3

FastAPI

PostgreSQL

SQLAlchemy

Alembic

Redis

Docker

Docker Compose

Nginx

Loguru

Pytest

Pydantic

Use asynchronous programming.

====================================================

PROJECT STRUCTURE

====================================================

Follow clean architecture.

Separate

handlers

services

repositories

database

models

schemas

middlewares

keyboards

filters

config

utils

tests

====================================================

SECURITY

====================================================

Implement

Role Based Access Control

PIN Login

Telegram ID verification

Password hashing

Rate limiting

Audit logs

Encrypted backups

Environment variables

Validation

Error handling

====================================================

DATABASE

====================================================

Design a professional normalized database.

Include tables

users

roles

permissions

products

categories

stock

stock_movements

sales

sale_items

payments

customers

suppliers

expenses

reports

notifications

activity_logs

settings

backups

====================================================

PRODUCT MODULE

====================================================

Unlimited products

Barcode

SKU

Category

Supplier

Cost price

Selling price

Current stock

Minimum stock

Images

Search

Edit

Delete

Archive

====================================================

INVENTORY

====================================================

Receive stock

Adjust stock

Transfer stock

Damaged products

Returned products

Stock movement history

Automatic stock reduction after sale

Low stock alerts

Out of stock alerts

====================================================

SALES

====================================================

Create invoice

Multiple products

Discounts

Tax support

Customer selection

Guest checkout

Automatic stock deduction

Sales history

Search invoices

Refund workflow

====================================================

PAYMENTS

====================================================

Cash

Transfer

POS

Split Payment

Store payment references.

Track

Cash total

Transfer total

POS total

====================================================

RECEIPTS

====================================================

Generate beautiful receipts.

Include

Business logo

Invoice number

Date

Cashier

Items

Total

Payment method

QR Code

====================================================

REPORTS

====================================================

Daily

Weekly

Monthly

Yearly

Cash Report

Transfer Report

POS Report

Profit Report

Expense Report

Stock Report

====================================================

EXPENSES

====================================================

Fuel

Electricity

Transport

Rent

Salary

Miscellaneous

Automatically calculate profit.

====================================================

CUSTOMERS

====================================================

Customer database

Purchase history

Outstanding balance

Loyalty points

====================================================

SUPPLIERS

====================================================

Supplier database

Purchase history

Contact information

====================================================

NOTIFICATIONS

====================================================

Notify Owner instantly for

Every sale

Low stock

Large sales

Refunds

Failed login

Daily summary

====================================================

AI FEATURES

====================================================

Natural language business assistant.

Owner can ask

How much did we sell today?

Who sold the most?

Show low stock.

Best selling product.

Profit today.

Inventory valuation.

Generate weekly report.

====================================================

BACKUP

====================================================

Automatic backup

Manual backup

Restore backup

====================================================

LOGGING

====================================================

Every action must be logged.

====================================================

TESTING

====================================================

Unit tests

Integration tests

====================================================

DOCUMENTATION

====================================================

Generate

README

Installation guide

Deployment guide

API documentation

Administrator guide

Staff guide

====================================================

UI

====================================================

Design premium Telegram interfaces.

Use inline keyboards.

Emoji only where appropriate.

Professional navigation.

Pagination.

Search.

Confirmation dialogs.

====================================================

DEVELOPMENT RULES

====================================================

Never skip steps.

Build module by module.

Wait until each module is complete before moving to the next.

Generate production-quality code only.

Follow SOLID principles.

Use dependency injection where appropriate.

Write comments only where useful.

Provide folder names and file names before code.

Every module must include tests and documentation.

At the end of each module, explain how to run it and verify it works before continuing.

Continue until the entire STOREMAX POS system is complete and deployment-ready.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://bottle-beacon-business-suite.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/95a73a66-072a-4df7-a8fd-99abe66af3ee).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
