const http = require("http");
const { Server } = require("socket.io");
const express = require("express");

const sockets = require("./sockets.js");

const api = express();

api.use(express.json());

const httpServer = http.createServer(api);

const socketServer = new Server(httpServer, { path: "/sms/socket.io" });

const PORT = 4000;

httpServer.listen(PORT);

sockets.listen(socketServer);

api.post("/sms", async (req, res) => {
  const { phoneNumber, message } = req.body;

  const otp = Math.floor(100000 + Math.random() * 900000);

  const response = await fetch("https://www.sms.ma/mcms/sendsms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      login: "ctsMarrakech",
      password: "c@g3e87h4u",
      oadc: "MTAXI",
      msisdn_to: phoneNumber,
      body: message ?? `Votre code de vérification est: ${otp}`,
    }),
  });

  const data = await response.json();

  console.log(data);

  res.json(`${otp}`);
});
