---
title: DigitalOcean
description: 'Discover DigitalOcean preset for Nitro!'
---

**Preset:** `digital-ocean` ([switch to this preset](/deploy/#changing-the-deployment-preset))

Nitro supports deploying on the [Digital Ocean App Platform](https://docs.digitalocean.com/products/app-platform/) with minimal configuration.

## Set up application

1. Create a new Digital Ocean app following the [guide](https://docs.digitalocean.com/products/app-platform/how-to/create-apps/).

1. Next, you'll need to configure environment variables. In your app settings, ensure the following app-level environment variables are set:

   ```bash
   NITRO_PRESET=digital-ocean
   ```

   [More information](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/).

1. Finally, you will need to ensure you set an `engines.node` field in your app's `package.json` to ensure Digital Ocean uses a supported version of Node.js:

   ```json
   {
      "engines": {
         "node": "16.x"
      }
   }
   ```

   [See more information](https://docs.digitalocean.com/products/app-platform/languages-frameworks/nodejs/#node-version).

You can now follow [the rest of the Digital Ocean deployment guide](https://docs.digitalocean.com/products/app-platform/how-to/manage-deployments/).
