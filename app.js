#!/usr/bin/env node
import { setup } from "./index.js"

async function main() {
    const mikser = await setup()
    await mikser.start()
}
main()