(function (root, factory) {
  const catalog = factory();
  if (typeof module === "object" && module.exports) module.exports = catalog;
  else root.MmhCatalog = catalog;
})(globalThis, function () {
  const products = [
    { id: "gpu-1", category: "gpu", type: "Tarjeta de video", brand: "Gigabyte AORUS", name: "GeForce RTX 5090 MASTER 32 GB", referencePrice: 55999, glyph: "◈", image: "assets/catalog/gpu-rtx-5090.svg", imageAlt: "Ilustración referencial de GeForce RTX 5090 MASTER 32 GB; no es una foto del fabricante", imageCredit: "Ilustración referencial MMH" },
    { id: "gpu-2", category: "gpu", type: "Tarjeta de video", brand: "ASUS ROG", name: "GeForce RTX 5080 16 GB", referencePrice: 27999, glyph: "◈", image: "assets/catalog/gpu-rtx-5080.svg", imageAlt: "Ilustración referencial de GeForce RTX 5080 16 GB; no es una foto del fabricante", imageCredit: "Ilustración referencial MMH" },
    { id: "gpu-3", category: "gpu", type: "Tarjeta de video", brand: "MSI Gaming Trio", name: "GeForce RTX 5070 Ti 16 GB", referencePrice: 19999, glyph: "◈", image: "assets/catalog/gpu-rtx-5070ti.svg", imageAlt: "Ilustración referencial de GeForce RTX 5070 Ti 16 GB; no es una foto del fabricante", imageCredit: "Ilustración referencial MMH" },
    { id: "gpu-4", category: "gpu", type: "Tarjeta de video", brand: "Sapphire Nitro+", name: "Radeon RX 9070 XT 16 GB", referencePrice: 16999, glyph: "◈", image: "assets/catalog/gpu-rx9070xt.svg", imageAlt: "Ilustración referencial de Radeon RX 9070 XT 16 GB; no es una foto del fabricante", imageCredit: "Ilustración referencial MMH" },
    { id: "motherboard-1", category: "motherboard", type: "Tarjeta madre", brand: "Gigabyte AORUS", name: "X870E AORUS MASTER · AM5", referencePrice: 13999, glyph: "▦", image: "assets/catalog/board-aorus-x870e.svg", imageAlt: "Ilustración referencial de X870E AORUS MASTER AM5; no es una foto del fabricante", imageCredit: "Ilustración referencial MMH" },
    { id: "motherboard-2", category: "motherboard", type: "Tarjeta madre", brand: "ASUS ROG", name: "Crosshair X870E Hero · AM5", referencePrice: 16999, glyph: "▦", image: "assets/catalog/board-rog-x870e.svg", imageAlt: "Ilustración referencial de Crosshair X870E Hero AM5; no es una foto del fabricante", imageCredit: "Ilustración referencial MMH" },
    { id: "motherboard-3", category: "motherboard", type: "Tarjeta madre", brand: "MSI MPG", name: "X870E Carbon WiFi · AM5", referencePrice: 11999, glyph: "▦", image: "assets/catalog/board-msi-carbon.svg", imageAlt: "Ilustración referencial de X870E Carbon WiFi AM5; no es una foto del fabricante", imageCredit: "Ilustración referencial MMH" },
    { id: "cpu-1", category: "cpu", type: "Procesador", brand: "AMD", name: "Ryzen 9 9950X3D · 16 núcleos", referencePrice: 12999, glyph: "▧", image: "assets/catalog/cpu-ryzen-9950x3d.svg", imageAlt: "Ilustración referencial de Ryzen 9 9950X3D", imageCredit: "Ilustración referencial MMH" },
    { id: "cpu-2", category: "cpu", type: "Procesador", brand: "AMD", name: "Ryzen 7 9800X3D · 8 núcleos", referencePrice: 8499, glyph: "▧", image: "assets/catalog/cpu-ryzen-9800x3d.svg", imageAlt: "Ilustración referencial de Ryzen 7 9800X3D", imageCredit: "Ilustración referencial MMH" },
    { id: "cpu-3", category: "cpu", type: "Procesador", brand: "Intel", name: "Core Ultra 9 285K · 24 núcleos", referencePrice: 11999, glyph: "▧", image: "assets/catalog/cpu-core-ultra-9-285k.svg", imageAlt: "Ilustración referencial de Core Ultra 9 285K", imageCredit: "Ilustración referencial MMH" },
    { id: "psu-1", category: "psu", type: "Fuente de poder", brand: "Corsair", name: "HX1200i · 1200 W · ATX 3.1", referencePrice: 7999, glyph: "ϟ", image: "assets/catalog/psu-hx1200i.svg", imageAlt: "Ilustración referencial de Corsair HX1200i 1200 W", imageCredit: "Ilustración referencial MMH" },
    { id: "psu-2", category: "psu", type: "Fuente de poder", brand: "be quiet!", name: "Dark Power 13 · 1000 W Titanium", referencePrice: 6999, glyph: "ϟ", image: "assets/catalog/psu-dark-power-13.svg", imageAlt: "Ilustración referencial de Dark Power 13 1000 W Titanium", imageCredit: "Ilustración referencial MMH" },
    { id: "psu-3", category: "psu", type: "Fuente de poder", brand: "Gigabyte AORUS", name: "Elite P1000W · 1000 W Gold", referencePrice: 3299, glyph: "ϟ", image: "assets/catalog/psu-aorus-p1000w.svg", imageAlt: "Ilustración referencial de Elite P1000W 1000 W Gold", imageCredit: "Ilustración referencial MMH" }
  ];
  const services = [
    { id: "service-web", name: "Diseño y desarrollo de página web", priceOnQuote: true },
    { id: "service-app", name: "Diseño y desarrollo de app para negocio", priceOnQuote: true },
    { id: "service-extra", name: "Servicios digitales extra a la medida", priceOnQuote: true }
  ];
  const productPrice = product => Math.ceil(product.referencePrice * 1.1);

  function priceOrderItems(inputItems) {
    if (!Array.isArray(inputItems) || inputItems.length === 0 || inputItems.length > 40) return null;
    const items = [];
    let subtotal = 0;
    let quoteRequired = false;
    for (const inputItem of inputItems) {
      const id = String(inputItem?.product?.id ?? inputItem?.id ?? "");
      const product = products.find(item => item.id === id);
      const service = product ? null : services.find(item => item.id === id);
      if (!product && !service) return null;
      const quantity = Math.min(99, Math.max(1, Math.floor(Number(inputItem.quantity) || 1)));
      if (product) {
        subtotal += productPrice(product) * quantity;
        items.push({ product: { id, name: product.name, priceOnQuote: false, referencePrice: product.referencePrice }, quantity });
      } else {
        quoteRequired = true;
        items.push({ product: { id, name: service.name, priceOnQuote: true, referencePrice: 0 }, quantity });
      }
    }
    return { items, subtotal, quoteRequired };
  }

  return { products, services, productPrice, priceOrderItems };
});
