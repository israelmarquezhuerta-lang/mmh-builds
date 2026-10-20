const localStore = require("./local-store");

const orderId = process.argv[2];
if (process.argv.length !== 3 || !/^MMH-[A-F0-9]{8}$/i.test(orderId || "")) {
  console.error("Uso: node confirmar-pago-local.js MMH-XXXXXXXX");
  process.exitCode = 1;
} else {
  try {
    const order = localStore.verifyOrderPayment(orderId.toUpperCase());
    console.log(`Pago verificado manualmente para ${order.id}. Se actualizaron sus puntos MMH Rewards.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
